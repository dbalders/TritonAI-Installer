const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  CANONICAL_PLUGIN_REPOSITORY_URL,
  assertCanonicalPluginRepository,
  sanitizeRepositoryUrl
} = require("../src/installer/plugin-provenance");
const {
  createManagedPluginBundleManifest
} = require("../src/installer/plugin-bundle-manifest");

const root = path.resolve(__dirname, "..", "..");
const vendorDir = path.join(root, "vendor", "plugins");
const requirementPath = path.join(root, "build", "managed-plugin-composition.generated.json");
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONTRACT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_.-]*$/;
const COMMIT = /^[a-f0-9]{40}$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function main(env = process.env) {
  const input = readPluginSourceEnvironment(env);
  const configured = Boolean(input.ref || input.commit || input.selectedIds.length || input.localSource);
  if (!configured) {
    fs.rmSync(vendorDir, { recursive: true, force: true });
    writePluginCompositionRequirement(false);
    console.log("Managed Harness plugin composition is not selected for this Installer build.");
    return null;
  }
  validateSourceInput(input);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-plugins-vendor-"));
  try {
    const sourceRoot = input.localSource
      ? cloneValidatedLocalSource(input, path.join(tempRoot, "repo"))
      : clonePinnedSource(input, path.join(tempRoot, "repo"));
    const result = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: input.selectedIds,
      source: {
        repository: CANONICAL_PLUGIN_REPOSITORY_URL,
        ref: input.ref,
        commit: input.commit
      }
    });
    writePluginCompositionRequirement(true);
    console.log(
      `Prepared ${result.packages.length} managed Harness plugin package${result.packages.length === 1 ? "" : "s"} `
      + `from ${CANONICAL_PLUGIN_REPOSITORY_URL}#${input.ref} (${input.commit}).`
    );
    console.log("Harness release composition must publish matching platform-specific composition proofs before Installer packaging can continue.");
    return result;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function writePluginCompositionRequirement(required) {
  fs.mkdirSync(path.dirname(requirementPath), { recursive: true });
  fs.writeFileSync(requirementPath, `${JSON.stringify({ version: 1, required }, null, 2)}\n`);
}

function readPluginSourceEnvironment(env: Record<string, string | undefined> = {}) {
  return {
    repository: env.TRITONAI_PLUGINS_REPO || CANONICAL_PLUGIN_REPOSITORY_URL,
    ref: (env.TRITONAI_PLUGINS_REF || "").trim(),
    commit: (env.TRITONAI_PLUGINS_COMMIT || "").trim().toLowerCase(),
    selectedIds: parseSelectedPluginIds(env.TRITONAI_PLUGIN_IDS || ""),
    localSource: env.TRITONAI_PLUGINS_SOURCE ? path.resolve(env.TRITONAI_PLUGINS_SOURCE) : ""
  };
}

function parseSelectedPluginIds(value) {
  const raw = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const selected = [...new Set(raw)].sort();
  if (selected.length !== raw.length) {
    throw new Error("TRITONAI_PLUGIN_IDS must not contain duplicate plugin ids.");
  }
  for (const id of selected) {
    if (!PLUGIN_ID.test(id)) throw new Error(`TRITONAI_PLUGIN_IDS contains an invalid plugin id: ${JSON.stringify(id)}.`);
  }
  return selected;
}

function validateSourceInput(input) {
  if (!input.ref || !isSafeGitRef(input.ref)) {
    throw new Error("TRITONAI_PLUGINS_REF must explicitly name a safe Git ref for the managed plugin release.");
  }
  if (!COMMIT.test(input.commit)) {
    throw new Error("TRITONAI_PLUGINS_COMMIT must explicitly pin the full lowercase 40-character Git commit SHA.");
  }
  if (input.selectedIds.length === 0) {
    throw new Error("TRITONAI_PLUGIN_IDS must explicitly select at least one production plugin package.");
  }
  const effectiveRepository = getEffectiveRepositoryUrl(input.repository, root);
  assertCanonicalPluginRepository(effectiveRepository, "TRITONAI_PLUGINS_REPO");
}

function isSafeGitRef(ref) {
  return /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(ref)
    && !ref.includes("..")
    && !ref.includes("@{")
    && !ref.includes("//")
    && !ref.endsWith("/")
    && !ref.endsWith(".")
    && !ref.endsWith(".lock");
}

function cloneValidatedLocalSource(input, target) {
  const sourceRoot = input.localSource;
  if (!fs.existsSync(sourceRoot) || !fs.lstatSync(sourceRoot).isDirectory()) {
    throw new Error(`TRITONAI_PLUGINS_SOURCE is not a directory: ${sourceRoot}`);
  }
  const configuredOrigin = git(sourceRoot, ["remote", "get-url", "origin"]);
  const effectiveOrigin = getEffectiveRepositoryUrl(configuredOrigin, sourceRoot);
  assertCanonicalPluginRepository(effectiveOrigin, "TRITONAI_PLUGINS_SOURCE origin");
  if (git(sourceRoot, ["status", "--porcelain"])) {
    throw new Error("TRITONAI_PLUGINS_SOURCE must be a clean checkout; dirty plugin validation work is never used for Installer packaging.");
  }
  const head = git(sourceRoot, ["rev-parse", "HEAD"]).toLowerCase();
  if (head !== input.commit) {
    throw new Error(`TRITONAI_PLUGINS_SOURCE HEAD ${head} does not match pinned TRITONAI_PLUGINS_COMMIT ${input.commit}.`);
  }
  assertRefResolvesToCommit(sourceRoot, input.ref, input.commit);
  assertRemoteRefResolvesToCommit(effectiveOrigin, input.ref, input.commit);
  try {
    execFileSync("git", ["clone", "--local", "--no-checkout", sourceRoot, target], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"]
    });
  } catch (_error) {
    throw new Error("Could not clone the pinned local plugin source.");
  }
  materializeSelectedPluginTrees(target, input.commit, input.selectedIds);
  return target;
}

function clonePinnedSource(input, target) {
  const effectiveRepository = getEffectiveRepositoryUrl(input.repository, root);
  assertCanonicalPluginRepository(effectiveRepository, "TRITONAI_PLUGINS_REPO");
  assertRemoteRefResolvesToCommit(input.repository, input.ref, input.commit);
  try {
    execFileSync("git", ["clone", "--no-checkout", input.repository, target], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"]
    });
  } catch (_error) {
    throw new Error(`Could not clone pinned managed plugins source from ${sanitizeRepositoryUrl(input.repository)}.`);
  }
  const origin = git(target, ["remote", "get-url", "origin"]);
  assertCanonicalPluginRepository(
    getEffectiveRepositoryUrl(origin, target),
    "Cloned TritonAI plugin origin"
  );
  materializeSelectedPluginTrees(target, input.commit, input.selectedIds);
  return target;
}

function materializeSelectedPluginTrees(repositoryRoot, commit, selectedIds) {
  const selectedPaths = selectedIds.map((id) => `plugins/${id}`);
  let output;
  try {
    output = execFileSync(
      "git",
      ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...selectedPaths],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (_error) {
    throw new Error("Could not enumerate the pinned managed plugin Git objects.");
  }
  const found = new Set();
  for (const record of output.split("\0").filter(Boolean)) {
    const match = record.match(/^(\d+) ([^ ]+) ([a-f0-9]{40,64})\t(.+)$/);
    if (!match) throw new Error("Pinned managed plugin tree contains an unsupported Git entry.");
    const [, mode, type, objectId, relative] = match;
    const selectedId = selectedIds.find((id) => relative.startsWith(`plugins/${id}/`));
    if (!selectedId || type !== "blob" || !["100644", "100755"].includes(mode) || !isSafeGitObjectPath(relative)) {
      throw new Error(`Pinned managed plugin tree contains an unsafe entry: ${relative}.`);
    }
    found.add(selectedId);
    const target = path.join(repositoryRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let contents;
    try {
      contents = execFileSync("git", ["cat-file", "blob", objectId], {
        cwd: repositoryRoot,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024
      });
    } catch (_error) {
      throw new Error(`Could not read pinned Git object for ${relative}.`);
    }
    fs.writeFileSync(target, contents, { mode: mode === "100755" ? 0o755 : 0o644 });
  }
  const missing = selectedIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Pinned commit does not contain selected plugin packages: ${missing.join(", ")}.`);
  }
}

function isSafeGitObjectPath(value) {
  if (!value.startsWith("plugins/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function assertRemoteRefResolvesToCommit(repository, ref, commit) {
  let output;
  try {
    output = execFileSync("git", ["ls-remote", repository, ref, `${ref}^{}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (_error) {
    throw new Error(`Could not resolve managed plugin ref ${ref} from ${sanitizeRepositoryUrl(repository)}.`);
  }
  const resolved = new Map(
    output.split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 2))
      .filter(([sha, name]) => COMMIT.test(sha) && (name === ref || name === `${ref}^{}`))
      .map(([sha, name]) => [name, sha])
  );
  const resolvedCommit = resolved.get(`${ref}^{}`) || resolved.get(ref);
  if (resolvedCommit !== commit) {
    throw new Error(`TRITONAI_PLUGINS_REF ${ref} does not resolve to pinned commit ${commit}.`);
  }
}

function assertRefResolvesToCommit(sourceRoot, ref, commit) {
  let resolved = "";
  try {
    resolved = git(sourceRoot, ["rev-parse", `${ref}^{commit}`]).toLowerCase();
  } catch (_error) {
    throw new Error(`TRITONAI_PLUGINS_REF ${ref} is not available in TRITONAI_PLUGINS_SOURCE.`);
  }
  if (resolved !== commit) {
    throw new Error(`TRITONAI_PLUGINS_REF ${ref} resolves to ${resolved}, not pinned commit ${commit}.`);
  }
}

function stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds, source }) {
  assertCanonicalPluginRepository(source.repository, "Managed plugin source");
  const pluginsRoot = path.join(sourceRoot, "plugins");
  validatePluginsRoot(pluginsRoot);
  const stagingDir = createSiblingTempDir(vendorDir, ".managed-plugins-vendor-");
  try {
    const packages = selectedIds.map((id) => stagePluginPackage(pluginsRoot, stagingDir, id));
    const manifest = createManagedPluginBundleManifest({ source, packages });
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    validateStagedVendor(stagingDir, manifest);
    activateStagedVendor(stagingDir, vendorDir);
    return manifest;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function validatePluginsRoot(pluginsRoot) {
  const stat = safeLstat(pluginsRoot, "TritonAI plugin packages root");
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("TritonAI plugin packages root must be a real directory.");
  }
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (entry.name === "README.md" && entry.isFile()) continue;
    if (entry.isSymbolicLink()) throw new Error(`Plugin package entries must not be symbolic links: ${entry.name}.`);
    if (!entry.isDirectory()) throw new Error(`Unexpected entry under plugins/: ${entry.name}.`);
  }
}

function stagePluginPackage(pluginsRoot, stagingDir, id) {
  const packageRoot = path.join(pluginsRoot, id);
  const packageStat = safeLstat(packageRoot, `Selected plugin ${id}`);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new Error(`Selected plugin ${id} must be a real package directory.`);
  }
  validateRegularTree(packageRoot, `Selected plugin ${id} source`, { skipNodeModules: true });
  const packageJson = readJson(path.join(packageRoot, "package.json"), `${id} package.json`);
  const pluginManifest = validatePluginManifest(
    readJson(path.join(packageRoot, ".tritonai-plugin", "plugin.json"), `${id} plugin manifest`),
    id
  );
  validatePackageMetadata(packageJson, pluginManifest, id);
  validatePluginMetadataDirectory(packageRoot, id);
  validateDeclaredSkillDirectories(packageRoot, pluginManifest, id);

  const targetRoot = path.join(stagingDir, "packages", id);
  fs.mkdirSync(targetRoot, { recursive: true });
  copyRequiredFile(packageRoot, targetRoot, "package.json");
  copyRequiredFile(packageRoot, targetRoot, "README.md");
  copyRequiredFile(packageRoot, targetRoot, "SECURITY.md");
  if (fs.existsSync(path.join(packageRoot, "LICENSE"))) copyRequiredFile(packageRoot, targetRoot, "LICENSE");
  copyRequiredFile(packageRoot, targetRoot, path.join(".tritonai-plugin", "plugin.json"));
  for (const skill of pluginManifest.skills) {
    const relative = path.join("skills", skill.name);
    copySafeTree(packageRoot, targetRoot, relative, `Plugin ${id} skill ${skill.name}`);
    validateSkillFrontmatter(path.join(targetRoot, relative, "SKILL.md"), skill, id);
  }
  if (pluginManifest.tools.length > 0) {
    copySafeTree(packageRoot, targetRoot, "dist", `Plugin ${id} provider distribution`);
  }

  const files = describeFiles(targetRoot);
  validatePackagedPaths(files.map((file) => file.path), pluginManifest, id);
  const digest = digestFileSet(targetRoot, files);
  return {
    id,
    name: packageJson.name,
    version: packageJson.version,
    digest,
    files
  };
}

function validatePackageMetadata(packageJson, manifest, id) {
  if (packageJson.name !== `@tritonai/plugin-${id}`) throw new Error(`${id}: package name drift.`);
  if (typeof packageJson.version !== "string" || !STABLE_SEMVER.test(packageJson.version)) {
    throw new Error(`${id}: package version must use stable semantic versioning.`);
  }
  if (packageJson.version !== manifest.version) throw new Error(`${id}: package/manifest version drift.`);
  if (!Array.isArray(packageJson.files)) throw new Error(`${id}: package files must be an explicit array.`);
  const required = [".tritonai-plugin", "skills", "README.md", "SECURITY.md"];
  const supported = new Set([...required, "dist", "LICENSE"]);
  if (new Set(packageJson.files).size !== packageJson.files.length) {
    throw new Error(`${id}: package files must not contain duplicates.`);
  }
  for (const entry of required) {
    if (!packageJson.files.includes(entry)) throw new Error(`${id}: package files omit ${entry}.`);
  }
  for (const entry of packageJson.files) {
    if (typeof entry !== "string" || !entry || path.isAbsolute(entry) || entry.includes("\\") || entry.split("/").includes("..")) {
      throw new Error(`${id}: package file allowlist contains an unsafe path.`);
    }
    if (entry === "src" || /(?:^|[./_-])tests?(?:[./_-]|$)/i.test(entry) || entry.endsWith("harness.ts")) {
      throw new Error(`${id}: package file allowlist includes source, tests, or a Harness adapter.`);
    }
    if (!supported.has(entry)) {
      throw new Error(`${id}: package file allowlist contains unsupported entry ${entry}.`);
    }
  }
  if (manifest.tools.length > 0) {
    if (!packageJson.files.includes("dist")) throw new Error(`${id}: provider package files omit dist.`);
    if (packageJson.exports?.["."]?.types !== "./dist/index.d.ts" || packageJson.exports?.["."]?.default !== "./dist/index.js") {
      throw new Error(`${id}: provider package must export dist/index.js and dist/index.d.ts.`);
    }
  }
}

function validatePluginMetadataDirectory(packageRoot, id) {
  const metadataRoot = path.join(packageRoot, ".tritonai-plugin");
  const entries = fs.readdirSync(metadataRoot, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== "plugin.json" || !entries[0].isFile()) {
    throw new Error(`${id}: .tritonai-plugin must contain only plugin.json.`);
  }
}

function validateDeclaredSkillDirectories(packageRoot, manifest, id) {
  const skillsRoot = path.join(packageRoot, "skills");
  const actual = fs.readdirSync(skillsRoot, { withFileTypes: true });
  if (actual.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(`${id}: skills must contain only real skill directories.`);
  }
  const actualNames = actual
    .filter((entry) => fs.readdirSync(path.join(skillsRoot, entry.name)).length > 0)
    .map((entry) => entry.name)
    .sort();
  const declaredNames = manifest.skills.map((skill) => skill.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(declaredNames)) {
    throw new Error(`${id}: package skills and manifest skill declarations drift.`);
  }
}

function validatePluginManifest(value, expectedId) {
  assertRecord(value, `${expectedId} plugin manifest`);
  const keys = new Set(["apiVersion", "kind", "manifestVersion", "id", "name", "description", "version", "provider", "capabilities", "tools", "skills"]);
  assertOnlyKeys(value, keys, `${expectedId} plugin manifest`);
  if (value.apiVersion !== "tritonai.harness/v2" || value.kind !== "IntegrationPlugin" || value.manifestVersion !== 2) {
    throw new Error(`${expectedId}: unsupported Harness plugin manifest contract.`);
  }
  if (value.id !== expectedId || !PLUGIN_ID.test(value.id)) throw new Error(`${expectedId}: manifest id drift.`);
  for (const field of ["name", "description", "version"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`${expectedId}: manifest ${field} is required.`);
  }
  if (!STABLE_SEMVER.test(value.version)) throw new Error(`${expectedId}: manifest version must be stable semver.`);
  if (!Array.isArray(value.capabilities) || !Array.isArray(value.tools) || !Array.isArray(value.skills)) {
    throw new Error(`${expectedId}: capabilities, tools, and skills must be arrays.`);
  }
  if ((value.tools.length > 0) !== (typeof value.provider === "string" && value.provider.length > 0)) {
    throw new Error(`${expectedId}: provider must be declared exactly when tools are declared.`);
  }
  if (value.provider !== undefined && (value.provider.length > 64 || !CONTRACT_ID.test(value.provider))) {
    throw new Error(`${expectedId}: provider identifier is invalid.`);
  }
  const capabilities = new Set();
  for (const capability of value.capabilities) {
    assertRecord(capability, `${expectedId} capability`);
    assertOnlyKeys(capability, new Set(["id", "displayName", "description", "access"]), `${expectedId} capability`);
    if (!stringFields(capability, ["id", "displayName", "description"])
      || capability.id.length > 64
      || !CONTRACT_ID.test(capability.id)
      || !["default", "opt-in"].includes(capability.access)
      || capabilities.has(capability.id)) {
      throw new Error(`${expectedId}: capabilities must have unique ids and descriptions.`);
    }
    capabilities.add(capability.id);
  }
  for (const [kind, entries] of [["tool", value.tools], ["skill", value.skills]]) {
    const names = new Set();
    for (const entry of entries) {
      assertRecord(entry, `${expectedId} ${kind}`);
      assertOnlyKeys(
        entry,
        new Set(kind === "tool"
          ? ["name", "displayName", "description", "capabilities", "effect"]
          : ["name", "description", "capabilities"]),
        `${expectedId} ${kind}`
      );
      if (!stringFields(entry, kind === "tool" ? ["name", "displayName", "description"] : ["name", "description"])) {
        throw new Error(`${expectedId}: invalid ${kind} metadata.`);
      }
      const references = entry.capabilities;
      const validName = kind === "skill"
        ? entry.name.length <= 64 && PLUGIN_ID.test(entry.name)
        : entry.name.length <= 128 && TOOL_NAME.test(entry.name);
      if (!validName
        || names.has(entry.name)
        || !Array.isArray(references)
        || references.length === 0
        || references.some((capability) => typeof capability !== "string" || !capabilities.has(capability))
        || new Set(references).size !== references.length
        || (kind === "tool" && !["read", "write"].includes(entry.effect))) {
        throw new Error(`${expectedId}: invalid or duplicate ${kind} declaration.`);
      }
      names.add(entry.name);
    }
  }
  return value;
}

function stringFields(value, fields) {
  return fields.every((field) => typeof value[field] === "string" && value[field].trim());
}

function validatePackagedPaths(paths, manifest, id) {
  const declaredSkills = new Set(manifest.skills.map((skill) => skill.name));
  const required = new Set([
    ".tritonai-plugin/plugin.json",
    "README.md",
    "SECURITY.md",
    "package.json",
    ...[...declaredSkills].map((name) => `skills/${name}/SKILL.md`),
    ...(manifest.tools.length > 0 ? ["dist/index.js", "dist/index.d.ts"] : [])
  ]);
  for (const requiredPath of required) {
    if (!paths.includes(requiredPath)) throw new Error(`${id}: composed package is missing ${requiredPath}.`);
  }
  for (const relative of paths) {
    if (relative.split("/").includes("node_modules")) {
      throw new Error(`${id}: composed package cannot contain node_modules content: ${relative}.`);
    }
    if (["README.md", "SECURITY.md", "LICENSE", "package.json", ".tritonai-plugin/plugin.json"].includes(relative)) continue;
    if (relative.startsWith("skills/")) {
      const skill = relative.split("/")[1];
      if (declaredSkills.has(skill)) continue;
    }
    if (relative.startsWith("dist/") && manifest.tools.length > 0) {
      const distPath = relative.slice("dist/".length);
      if (!/(?:\.js|\.json|\.d\.ts)$/i.test(distPath)
        || /(?:^|[./_-])(?:spec|test|fixture)s?(?:[./_-]|$)/i.test(distPath)
        || (/\.tsx?$/i.test(distPath) && !/\.d\.ts$/i.test(distPath))) {
        throw new Error(`${id}: composed provider contains source, tests, or an unsupported file: ${relative}.`);
      }
      continue;
    }
    throw new Error(`${id}: composed package contains an unsafe or undeclared path: ${relative}.`);
  }
}

function validateSkillFrontmatter(skillFile, declaration, pluginId) {
  if (!fs.existsSync(skillFile)) throw new Error(`${pluginId}/${declaration.name}: skill is missing SKILL.md.`);
  const content = fs.readFileSync(skillFile, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${pluginId}/${declaration.name}: SKILL.md requires bounded YAML frontmatter.`);
  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!field || !["name", "description"].includes(field[1])) continue;
    if (Object.hasOwn(values, field[1])) throw new Error(`${pluginId}/${declaration.name}: duplicate ${field[1]} frontmatter.`);
    values[field[1]] = unquoteYamlScalar(field[2]);
  }
  if (values.name !== declaration.name || values.description !== declaration.description) {
    throw new Error(`${pluginId}/${declaration.name}: skill frontmatter and plugin manifest drift.`);
  }
}

function unquoteYamlScalar(value) {
  if (/^".*"$/.test(value)) {
    try { return JSON.parse(value); } catch (_error) { return value; }
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function copyRequiredFile(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const stat = safeLstat(source, `Required plugin file ${relative}`);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Required plugin file must be regular: ${relative}.`);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copySafeTree(sourceRoot, targetRoot, relative, label) {
  const source = path.join(sourceRoot, relative);
  const stat = safeLstat(source, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  validateRegularTree(source, label);
  fs.cpSync(source, path.join(targetRoot, relative), { recursive: true, force: false, errorOnExist: true });
}

function validateRegularTree(root, label, options: { skipNodeModules?: boolean } = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (options.skipNodeModules && entry.name === "node_modules") continue;
    const child = path.join(root, entry.name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links: ${entry.name}.`);
    if (stat.isDirectory()) validateRegularTree(child, label, options);
    else if (!stat.isFile()) throw new Error(`${label} can contain only regular files and directories: ${entry.name}.`);
  }
}

function describeFiles(root) {
  const files = [];
  walkFiles(root, "", files);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function walkFiles(root, relative, result) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(root, childRelative);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`Composed plugin cannot contain symbolic links: ${childRelative}.`);
    if (stat.isDirectory()) walkFiles(root, childRelative, result);
    else if (stat.isFile()) result.push({ path: childRelative, sha256: sha256(child), size: stat.size });
    else throw new Error(`Composed plugin contains a special file: ${childRelative}.`);
  }
}

function digestFileSet(root, files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.size), "utf8");
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, file.path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function validateStagedVendor(stagingDir, manifest) {
  const entries = fs.readdirSync(stagingDir).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["manifest.json", "packages"])) {
    throw new Error("Managed plugin vendor staging contains unexpected root entries.");
  }
  for (const plugin of manifest.packages) {
    const packageRoot = path.join(stagingDir, "packages", plugin.id);
    const files = describeFiles(packageRoot);
    if (JSON.stringify(files) !== JSON.stringify(plugin.files) || digestFileSet(packageRoot, files) !== plugin.digest) {
      throw new Error(`Managed plugin vendor staging drifted after composing ${plugin.id}.`);
    }
  }
}

function activateStagedVendor(stagingDir, targetDir) {
  const backupRoot = createSiblingTempDir(targetDir, ".managed-plugins-vendor-backup-");
  const previous = path.join(backupRoot, "previous");
  let previousMoved = false;
  try {
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, previous);
      previousMoved = true;
    }
    fs.renameSync(stagingDir, targetDir);
  } catch (error) {
    const rollbackErrors = [];
    if (previousMoved && fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    if (previousMoved) {
      try {
        fs.renameSync(previous, targetDir);
        previousMoved = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    const rollbackFailure = rollbackErrors.length
      ? `; rollback failed: ${rollbackErrors.join("; ")}; previous vendor kept at ${previous}`
      : "";
    throw new Error(`Could not atomically activate managed plugin vendor: ${error.message}${rollbackFailure}`);
  } finally {
    if (!previousMoved) fs.rmSync(backupRoot, { recursive: true, force: true });
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
}

function createSiblingTempDir(target, prefix) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function readJson(file, label) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`Could not read ${label}: ${error.message}`); }
  return value;
}

function safeLstat(file, label) {
  try { return fs.lstatSync(file); }
  catch (error) { throw new Error(`${label} is missing: ${file}.`); }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertOnlyKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`${label} contains unsupported fields: ${unsupported.join(", ")}.`);
}

function getEffectiveRepositoryUrl(repository, cwd) {
  try {
    return execFileSync("git", ["ls-remote", "--get-url", repository], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (_error) {
    const safe = sanitizeRepositoryUrl(repository);
    throw new Error(`Could not resolve effective managed plugin Git URL ${safe}.`);
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (_error) {
    throw new Error("Git could not validate the managed plugin source.");
  }
}

if (require.main === module) main();

module.exports = {
  activateStagedVendor,
  cloneValidatedLocalSource,
  digestFileSet,
  isSafeGitRef,
  isSafeGitObjectPath,
  main,
  materializeSelectedPluginTrees,
  parseSelectedPluginIds,
  readPluginSourceEnvironment,
  stagePluginsFromSource,
  validatePluginManifest,
  validateSourceInput,
  writePluginCompositionRequirement
};
