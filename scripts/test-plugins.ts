const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertCanonicalPluginRepository,
  CANONICAL_PLUGIN_REPOSITORY_URL
} = require("../src/installer/plugin-provenance");
const {
  assertArtifactBinding,
  assertMatchingPluginComposition,
  assertPluginCompatibility,
  isSafeRelativePath,
  validateManagedPluginBundleManifest
} = require("../src/installer/plugin-bundle-manifest");
const {
  findBundledPluginComposition,
  inspectBundledPluginComposition,
  readPluginCompositionRequirement
} = require("../src/installer/plugins");
const {
  parseSelectedPluginIds,
  readPluginSourceEnvironment,
  stagePluginsFromSource,
  validatePluginManifest,
  validateSourceInput
} = require("./prepare-plugins-vendor");

const COMMIT = "a".repeat(40);

function main() {
  assertCanonicalProvenance();
  assertExplicitSourceContract();
  assertDeterministicSelectionAndStaging();
  assertRejectsUnsafePackages();
  assertAtomicVendorRollback();
  assertCompositionContract();
  assertSafeCompositionPaths();
  assertPackagedResourceInspection();
  console.log("Managed Harness plugin tests passed.");
}

function assertSafeCompositionPaths() {
  for (const relative of ["dist/index.js", ".tritonai-plugin/plugin.json", "skills/graph/SKILL.md"]) {
    assert.strictEqual(isSafeRelativePath(relative), true);
  }
  for (const unsafe of ["../escape", "dist/../escape", "/absolute", "C:/absolute", "dist\\index.js", "dist//index.js", "./package.json"] ) {
    assert.strictEqual(isSafeRelativePath(unsafe), false, unsafe);
  }
}

function assertCanonicalProvenance() {
  for (const repository of [
    CANONICAL_PLUGIN_REPOSITORY_URL,
    "ssh://git@github.com/dbalders/TritonAI-Plugins.git",
    "git@github.com:dbalders/TritonAI-Plugins.git"
  ]) {
    assert.strictEqual(assertCanonicalPluginRepository(repository), "dbalders/TritonAI-Plugins");
  }
  for (const repository of [
    "https://github.com/dbalders/TritonAI-Plugin.git",
    "https://github.com.evil.example/dbalders/TritonAI-Plugins.git",
    "https://gitlab.com/dbalders/TritonAI-Plugins.git",
    "file:///tmp/TritonAI-Plugins",
    "/tmp/TritonAI-Plugins"
  ]) {
    assert.throws(() => assertCanonicalPluginRepository(repository), /not accepted as managed plugin provenance/);
  }
  assert.throws(
    () => assertCanonicalPluginRepository("https://secret@github.com/dbalders/TritonAI-Plugins.git?token=private"),
    (error) => !error.message.includes("secret") && !error.message.includes("private")
  );
  assert.throws(
    () => assertCanonicalPluginRepository("https://build-token@github.com:bad/dbalders/TritonAI-Plugins.git"),
    (error) => !error.message.includes("build-token") && error.message.includes("invalid-repository-url")
  );
}

function assertExplicitSourceContract() {
  assert.deepStrictEqual(parseSelectedPluginIds("zeta-reader,alpha-reader"), ["alpha-reader", "zeta-reader"]);
  assert.throws(() => parseSelectedPluginIds("alpha-reader,alpha-reader"), /duplicate/);
  assert.throws(() => parseSelectedPluginIds("../escape"), /invalid plugin id/);
  const environment = readPluginSourceEnvironment({
    TRITONAI_PLUGINS_REF: "refs/tags/plugins-v1",
    TRITONAI_PLUGINS_COMMIT: COMMIT,
    TRITONAI_PLUGIN_IDS: "alpha-reader"
  });
  assert.strictEqual(environment.repository, CANONICAL_PLUGIN_REPOSITORY_URL);
  assert.strictEqual(environment.localSource, "", "nearby checkouts must never be inferred");
  assert.deepStrictEqual(environment.selectedIds, ["alpha-reader"]);
  assert.throws(
    () => validateSourceInput({ ...environment, ref: "" }),
    /TRITONAI_PLUGINS_REF/
  );
  assert.throws(
    () => validateSourceInput({ ...environment, ref: "plugins-v1" }),
    /TRITONAI_PLUGINS_REF/
  );
  assert.throws(
    () => validateSourceInput({ ...environment, commit: "main" }),
    /TRITONAI_PLUGINS_COMMIT/
  );
  assert.throws(
    () => validateSourceInput({ ...environment, selectedIds: [] }),
    /TRITONAI_PLUGIN_IDS/
  );
}

function assertDeterministicSelectionAndStaging() {
  withTempRoot("tritonai-plugin-stage-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "zeta-reader", "1.2.3");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    fs.mkdirSync(path.join(sourceRoot, "plugins", "alpha-reader", "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "plugins", "alpha-reader", "src", "provider.ts"), "not packaged\n");
    fs.mkdirSync(path.join(sourceRoot, "plugins", "alpha-reader", "tests"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "plugins", "alpha-reader", "tests", "provider.test.ts"), "not packaged\n");

    const first = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader", "zeta-reader"],
      source: sourceIdentity()
    });
    assert.deepStrictEqual(first.packages.map((plugin) => plugin.id), ["alpha-reader", "zeta-reader"]);
    assert(!fs.existsSync(path.join(vendorDir, "packages", "alpha-reader", "src")));
    assert(!fs.existsSync(path.join(vendorDir, "packages", "alpha-reader", "tests")));
    const persisted = JSON.parse(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"));
    assert.deepStrictEqual(persisted, first);
    assert.strictEqual(validateManagedPluginBundleManifest(persisted), persisted);

    const firstBytes = fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8");
    const second = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader", "zeta-reader"],
      source: sourceIdentity()
    });
    assert.deepStrictEqual(second, first);
    assert.strictEqual(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"), firstBytes);
  });
}

function assertRejectsUnsafePackages() {
  withTempRoot("tritonai-plugin-reject-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const packageFile = path.join(sourceRoot, "plugins", "alpha-reader", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    packageJson.files.push("src");
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /allowlist includes source/
    );

    packageJson.files = packageJson.files.filter((entry) => entry !== "src");
    packageJson.files.push("assets");
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /unsupported entry assets/
    );

    packageJson.files = packageJson.files.filter((entry) => entry !== "assets");
    packageJson.version = "2.0.0";
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /package\/manifest version drift/
    );

    packageJson.version = "1.0.0";
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    const nestedModules = path.join(sourceRoot, "plugins", "alpha-reader", "skills", "alpha-reader", "node_modules");
    fs.mkdirSync(nestedModules, { recursive: true });
    fs.writeFileSync(path.join(nestedModules, "injected.js"), "injected\n");
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /cannot contain node_modules content/
    );
    fs.rmSync(nestedModules, { recursive: true, force: true });
    const link = path.join(sourceRoot, "plugins", "alpha-reader", "skills", "alpha-reader", "linked.md");
    try {
      fs.symlinkSync("SKILL.md", link);
      assert.throws(
        () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
        /symbolic links/
      );
    } catch (error) {
      if (!error || !["EPERM", "EACCES"].includes(error.code)) throw error;
    }

    const badManifest: Record<string, any> = pluginManifest("alpha-reader", "1.0.0");
    badManifest.unsupported = true;
    assert.throws(() => validatePluginManifest(badManifest, "alpha-reader"), /unsupported fields/);
  });
}

function assertAtomicVendorRollback() {
  withTempRoot("tritonai-plugin-rollback-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, "previous"), "owned previous vendor\n");
    const originalRename = fs.renameSync;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (!failed && target === vendorDir && path.basename(source).startsWith(".managed-plugins-vendor-")) {
        failed = true;
        throw new Error("simulated plugin vendor activation failure");
      }
      return originalRename(source, target);
    };
    try {
      assert.throws(
        () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
        /simulated plugin vendor activation failure/
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(fs.readFileSync(path.join(vendorDir, "previous"), "utf8"), "owned previous vendor\n");

    const originalRenameForInitialFailure = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source === vendorDir) throw new Error("simulated previous vendor move failure");
      return originalRenameForInitialFailure(source, target);
    };
    try {
      assert.throws(
        () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
        /simulated previous vendor move failure/
      );
    } finally {
      fs.renameSync = originalRenameForInitialFailure;
    }
    assert.strictEqual(
      fs.readFileSync(path.join(vendorDir, "previous"), "utf8"),
      "owned previous vendor\n",
      "a failed initial rename must preserve the previous vendor"
    );
  });
}

function assertCompositionContract() {
  withTempRoot("tritonai-plugin-composition-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const expected = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity()
    });
    assert.deepStrictEqual(assertMatchingPluginComposition(expected, structuredClone(expected)), expected);
    assert.deepStrictEqual(assertPluginCompatibility(expected, "0.2.7"), expected);
    const artifact = {
      fileName: "TritonAI-Harness-0.2.7-arm64.dmg",
      sha512: `${"A".repeat(86)}==`,
      size: 1234
    };
    const bound = { ...structuredClone(expected), artifacts: [artifact] };
    assert.deepStrictEqual(assertMatchingPluginComposition(expected, bound), bound);
    assert.deepStrictEqual(assertArtifactBinding(bound, artifact), artifact);
    assert.throws(
      () => assertArtifactBinding(bound, { ...artifact, size: artifact.size + 1 }),
      /not bound to the exact/
    );
    const incompatible = structuredClone(expected);
    incompatible.packages[0].compatibility.harness = { min: "0.3.0", maxExclusive: "0.4.0" };
    assert.throws(() => assertPluginCompatibility(incompatible, "0.2.7"), /requires TritonAI Harness/);
    const drifted = structuredClone(expected);
    drifted.packages[0].version = "1.0.1";
    assert.throws(() => assertMatchingPluginComposition(expected, drifted), /does not match the exact prepared/);
  });
}

function assertPackagedResourceInspection() {
  withTempRoot("tritonai-plugin-resource-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const resourcesPath = path.join(tempRoot, "resources");
    assert.throws(
      () => readPluginCompositionRequirement({ resourcesPath, appRoot: tempRoot, required: true }),
      /missing managed-plugin-composition.json/
    );
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, "managed-plugin-composition.json"), JSON.stringify({ version: 1, required: true }));
    assert.strictEqual(readPluginCompositionRequirement({ resourcesPath, appRoot: tempRoot, required: true }), true);
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const manifest = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity()
    });
    const compositionPath = path.join(resourcesPath, "vendor", "t3code-desktop", "mac-arm64", "tritonai-plugin-composition.json");
    const artifactPath = path.join(path.dirname(compositionPath), "TritonAI-Harness-0.2.7-arm64.dmg");
    fs.mkdirSync(path.dirname(compositionPath), { recursive: true });
    fs.writeFileSync(artifactPath, "bound harness artifact");
    const artifact = {
      fileName: path.basename(artifactPath),
      size: fs.statSync(artifactPath).size,
      sha512: require("crypto").createHash("sha512").update(fs.readFileSync(artifactPath)).digest("base64")
    };
    const boundManifest = { ...manifest, artifacts: [artifact] };
    fs.writeFileSync(compositionPath, JSON.stringify(boundManifest));
    assert.strictEqual(findBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot }), compositionPath);
    assert.deepStrictEqual(inspectBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot, required: true }), boundManifest);
    fs.writeFileSync(artifactPath, "tampered harness artifact");
    assert.throws(
      () => inspectBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot, required: true }),
      /not bound to the exact/
    );
    fs.rmSync(artifactPath);
    fs.rmSync(compositionPath);
    assert.throws(
      () => inspectBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot, required: true }),
      /cannot be verified/
    );
  });
}

function writeSkillPlugin(sourceRoot, id, version) {
  const packageRoot = path.join(sourceRoot, "plugins", id);
  fs.mkdirSync(path.join(packageRoot, ".tritonai-plugin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "skills", id), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "README.md"), `# ${id}\n`);
  fs.writeFileSync(path.join(packageRoot, "SECURITY.md"), "# Security\n");
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: `@tritonai/plugin-${id}`,
    version,
    files: [".tritonai-plugin", "skills", "README.md", "SECURITY.md"]
  }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(packageRoot, ".tritonai-plugin", "plugin.json"),
    `${JSON.stringify(pluginManifest(id, version), null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(packageRoot, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Read ${id} data.\n---\n# ${id}\n`
  );
}

function pluginManifest(id, version) {
  return {
    apiVersion: "tritonai.harness/v1",
    kind: "IntegrationPlugin",
    manifestVersion: 1,
    id,
    name: id,
    description: `Read ${id} data.`,
    version,
    compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } },
    capabilities: [{ id: `${id}.read`, displayName: "Read", description: "Read data.", access: "default" }],
    tools: [],
    skills: [{ name: id, description: `Read ${id} data.`, capabilities: [`${id}.read`] }]
  };
}

function sourceIdentity() {
  return { repository: CANONICAL_PLUGIN_REPOSITORY_URL, ref: "refs/tags/plugins-v1", commit: COMMIT };
}

function withTempRoot(prefix, callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { callback(tempRoot); }
  finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
}

main();
