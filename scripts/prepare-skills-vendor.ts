const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  createManagedSkillsManifest,
  isValidSkillName
} = require("../src/installer/skill-manifest");

const root = path.resolve(__dirname, "..", "..");
const localSourceOverride = process.env.UCSD_SKILLS_SOURCE;
const repo = process.env.UCSD_SKILLS_REPO || "https://github.com/dbalders/UCSD-Skills-Library-Secure.git";
const ref = process.env.UCSD_SKILLS_REF || "main";
const sourceSubdir = process.env.UCSD_SKILLS_SUBDIR || "";
const vendorDir = path.join(root, "vendor", "skills");
const CANONICAL_SECURE_REPOSITORY = "dbalders/UCSD-Skills-Library-Secure";
const localSourceCandidates = localSourceOverride
  ? [localSourceOverride]
  : [
      path.join(root, "..", "..", "UCSD-Skills-Library-Secure"),
      path.join(root, "..", "..", "..", "UCSD-Skills-Library-Secure")
    ];

function main() {
  const localSource = findLocalSkillsSource(localSourceCandidates, sourceSubdir);
  if (localSourceOverride && !localSource) {
    throw new Error("UCSD_SKILLS_SOURCE does not contain packageable root-level secure skills.");
  }
  if (localSource) {
    assertCanonicalLocalSecureSkillsSource(localSource);
    const result = stageSkillsFromSource({
      sourceRoot: localSource,
      sourceSubdir,
      vendorDir,
      sourceInfo: getLocalSourceInfo(localSource)
    });
    console.log(`Prepared ${result.skills.length} managed secure skill${result.skills.length === 1 ? "" : "s"} from a local checkout.`);
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-secure-skills-vendor-"));
  try {
    assertCanonicalSecureSkillsRepository(repo, "UCSD_SKILLS_REPO");
    const cloneDir = path.join(tempRoot, "repo");
    cloneSecureRepository(repo, ref, cloneDir);
    const result = stageSkillsFromSource({
      sourceRoot: cloneDir,
      sourceSubdir,
      vendorDir,
      sourceInfo: {
        type: "git",
        repo: sanitizeRepositoryUrl(repo),
        ref,
        commit: getGitValue(cloneDir, ["rev-parse", "HEAD"])
      }
    });

    console.log(`Prepared ${result.skills.length} managed secure skill${result.skills.length === 1 ? "" : "s"} from ${sanitizeRepositoryUrl(repo)}#${ref}.`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function findLocalSkillsSource(candidates, subdir = "") {
  return candidates
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => findSkillsSourceDir(candidate, subdir));
}

function stageSkillsFromSource({ sourceRoot, sourceSubdir = "", vendorDir, sourceInfo }) {
  if (sourceInfo && sourceInfo.repo) {
    assertCanonicalSecureSkillsRepository(sourceInfo.repo, "secure skills source");
  }
  const skillsSource = findSkillsSourceDir(sourceRoot, sourceSubdir);
  if (!skillsSource) {
    const location = sourceSubdir ? `${sourceRoot} (subdirectory ${sourceSubdir})` : sourceRoot;
    throw new Error(`Secure skills source has no root-level skill folders with SKILL.md: ${location}`);
  }

  const skillNames = findPackagedSkillNames(skillsSource);
  if (skillNames.length === 0) {
    throw new Error(`Secure skills source has no packageable root-level skill folders with SKILL.md: ${skillsSource}`);
  }

  const stagingDir = createSiblingTempDir(vendorDir, ".secure-skills-vendor-");
  try {
    for (const skillName of skillNames) {
      const sourceSkill = path.join(skillsSource, skillName);
      validateSkillDirectory(sourceSkill, skillName, "Secure skills source");
      fs.cpSync(sourceSkill, path.join(stagingDir, skillName), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: shouldCopySkillEntry
      });
    }

    const manifest = {
      ...createManagedSkillsManifest(skillNames),
      ...(sourceInfo ? { source: sanitizeSourceInfo(sourceInfo) } : {})
    };
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    activateStagedVendor(stagingDir, vendorDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  return { source: sanitizeSourceInfo(sourceInfo), skills: skillNames };
}

function assertCanonicalLocalSecureSkillsSource(sourceRoot) {
  const repository = getGitValue(sourceRoot, ["remote", "get-url", "origin"]);
  if (!repository) {
    throw new Error(`Secure skills override must be a Git checkout of ${CANONICAL_SECURE_REPOSITORY}; no origin remote was found at ${sourceRoot}.`);
  }
  assertCanonicalSecureSkillsRepository(repository, "UCSD_SKILLS_SOURCE");
}

function assertCanonicalSecureSkillsRepository(repository, label = "secure skills repository") {
  const slug = repositorySlug(repository);
  if (slug.toLowerCase() !== CANONICAL_SECURE_REPOSITORY.toLowerCase()) {
    throw new Error(`${label} must resolve to the private ${CANONICAL_SECURE_REPOSITORY} repository; ${sanitizeRepositoryUrl(repository)} is not accepted as secure skills provenance.`);
  }
  return slug;
}

function repositorySlug(repository) {
  const sanitized = sanitizeRepositoryUrl(repository).replace(/\\/g, "/").replace(/\.git$/i, "");
  let repositoryPath = sanitized;
  try {
    const parsed = new URL(sanitized);
    repositoryPath = parsed.pathname;
  } catch (_error) {
    const scpMatch = sanitized.match(/^[^:]+:(.+)$/);
    if (scpMatch) repositoryPath = scpMatch[1];
  }
  const parts = repositoryPath.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function findSkillsSourceDir(sourceRoot, subdir = "") {
  const candidate = path.resolve(sourceRoot, subdir);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    return null;
  }
  return findPackagedSkillNames(candidate).length > 0 ? candidate : null;
}

function findPackagedSkillNames(skillsSource) {
  return fs.readdirSync(skillsSource, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(skillsSource, entry.name, "SKILL.md")))
    .map((entry) => {
      if (!isValidSkillName(entry.name)) {
        throw new Error(`Secure skills source contains invalid skill folder name ${JSON.stringify(entry.name)}.`);
      }
      validateSkillDirectory(path.join(skillsSource, entry.name), entry.name, "Secure skills source");
      return entry.name;
    })
    .sort();
}

function validateSkillDirectory(skillDir, skillName, label) {
  const directoryStat = fs.lstatSync(skillDir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${label} skill ${JSON.stringify(skillName)} must be a real directory.`);
  }
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`${label} skill ${JSON.stringify(skillName)} is missing SKILL.md.`);
  }
  const skillStat = fs.lstatSync(skillFile);
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error(`${label} skill ${JSON.stringify(skillName)} must contain a regular SKILL.md file.`);
  }
  validateSkillTree(skillDir, `${label} skill ${JSON.stringify(skillName)}`);
}

function validateSkillTree(root, label) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} cannot contain symbolic links: ${entry.name}`);
    }
    if (stat.isDirectory()) {
      validateSkillTree(entryPath, label);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`${label} can contain only regular files and directories: ${entry.name}`);
    }
  }
}

function shouldCopySkillEntry(entry) {
  const basename = path.basename(entry);
  return basename !== ".DS_Store" && !entry.includes(`${path.sep}.git${path.sep}`) && !entry.endsWith(`${path.sep}.git`);
}

function createSiblingTempDir(target, prefix) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function activateStagedVendor(stagingDir, vendorDir) {
  let backupRoot = null;
  let previousVendorDir = null;
  let previousVendorMoved = false;

  try {
    if (fs.existsSync(vendorDir)) {
      backupRoot = createSiblingTempDir(vendorDir, ".secure-skills-vendor-backup-");
      previousVendorDir = path.join(backupRoot, "previous");
      fs.renameSync(vendorDir, previousVendorDir);
      previousVendorMoved = true;
    }
    fs.renameSync(stagingDir, vendorDir);
  } catch (error) {
    const rollbackErrors = [];
    if (previousVendorMoved && !fs.existsSync(vendorDir)) {
      try {
        fs.renameSync(previousVendorDir, vendorDir);
        previousVendorMoved = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    if (backupRoot && !previousVendorMoved) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
    const rollbackSuffix = rollbackErrors.length > 0
      ? ` Rollback also reported: ${rollbackErrors.join("; ")}`
      : "";
    throw new Error(`Could not activate the staged secure skills vendor: ${error.message}.${rollbackSuffix}`);
  }

  if (backupRoot) {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

function getLocalSourceInfo(sourceRoot) {
  const commit = getGitValue(sourceRoot, ["rev-parse", "HEAD"]);
  const repository = getGitValue(sourceRoot, ["remote", "get-url", "origin"]);
  const dirty = getGitValue(sourceRoot, ["status", "--porcelain"]) !== "";
  return {
    type: "local",
    ...(repository ? { repo: sanitizeRepositoryUrl(repository) } : {}),
    ...(commit ? { commit, dirty } : {})
  };
}

function sanitizeSourceInfo(sourceInfo) {
  if (!sourceInfo || typeof sourceInfo !== "object") return undefined;
  return {
    ...(typeof sourceInfo.type === "string" ? { type: sourceInfo.type } : {}),
    ...(typeof sourceInfo.repo === "string" ? { repo: sanitizeRepositoryUrl(sourceInfo.repo) } : {}),
    ...(typeof sourceInfo.ref === "string" ? { ref: sourceInfo.ref } : {}),
    ...(typeof sourceInfo.commit === "string" && sourceInfo.commit ? { commit: sourceInfo.commit } : {}),
    ...(typeof sourceInfo.dirty === "boolean" ? { dirty: sourceInfo.dirty } : {})
  };
}

function sanitizeRepositoryUrl(value) {
  const raw = String(value).trim();
  if (path.isAbsolute(raw) || raw.startsWith("file:")) {
    return "local-repository";
  }
  try {
    const parsed = new URL(raw);
    if (["http:", "https:", "ssh:"].includes(parsed.protocol)) {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch (_error) {
    // SCP-style Git remotes are not URL-parseable and are handled below.
  }
  const scpStyle = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpStyle) {
    const [, host, repositoryPath] = scpStyle;
    return `${host}:${repositoryPath.replace(/[?#].*$/, "")}`;
  }
  return raw.replace(/[?#].*$/, "");
}

function getGitValue(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (_error) {
    return "";
  }
}

function cloneSecureRepository(repository, branch, target) {
  try {
    execFileSync("git", ["clone", "--depth", "1", "--branch", branch, repository, target], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"]
    });
  } catch (error) {
    const safeRepository = sanitizeRepositoryUrl(repository);
    const stderr = String(error.stderr || "")
      .replaceAll(String(repository), safeRepository)
      .trim();
    throw new Error(`Could not clone secure skills repository ${safeRepository}#${branch}${stderr ? `: ${stderr}` : "."}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CANONICAL_SECURE_REPOSITORY,
  assertCanonicalLocalSecureSkillsSource,
  assertCanonicalSecureSkillsRepository,
  findPackagedSkillNames,
  findSkillsSourceDir,
  findLocalSkillsSource,
  sanitizeRepositoryUrl,
  stageSkillsFromSource
};
