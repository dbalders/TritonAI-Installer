const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./atomic-file");
const {
  createManagedSkillsManifest,
  isValidSkillName,
  validateManagedSkillsManifest
} = require("./skill-manifest");
const { defaultAppRoot } = require("./app-root");
const { assertCanonicalSecureSkillsRepository } = require("./secure-skills-provenance");

interface SkillsBundleOptions {
  resourcesPath?: string;
  appRoot?: string;
}

interface InstallBundledSkillsOptions extends SkillsBundleOptions {
  paths: Record<string, string>;
  emit?: InstallerEmit;
  copySkill?: (source: string, target: string) => void;
}

const MANAGED_SKILLS_MANIFEST_FILE = ".tritonai-managed-skills.json";
const VENDOR_SKILLS_MANIFEST_FILE = "manifest.json";
const VENDOR_SKILLS_LICENSE_FILE = "LICENSE";
const LEGACY_SKILLS_MANIFEST_FILE = "manifest.json";
const SKILLS_TRANSACTION_JOURNAL_FILE = ".tritonai-secure-skills-transaction.json";
const SKILLS_TRANSACTION_SCHEMA_VERSION = 1;
const SKILLS_STAGE_PREFIX = ".tritonai-secure-skills-stage-";
const SKILLS_BACKUP_PREFIX = ".tritonai-secure-skills-backup-";

function installBundledSkills(options: InstallBundledSkillsOptions) {
  const {
    paths,
    emit = () => {},
    resourcesPath,
    appRoot,
    copySkill = copySkillDirectory
  } = options;
  fs.mkdirSync(paths.skillsDir, { recursive: true });
  recoverInterruptedSkillsTransaction(paths.skillsDir, emit);
  const source = findBundledSkillsDir({ resourcesPath, appRoot });

  if (!source) {
    emit("No bundled managed secure skills found; existing installed skills were left unchanged.");
    return { installed: 0, removed: 0, source: null };
  }

  const bundledManifest = readBundledManifest(source);
  const managedManifestPath = path.join(paths.skillsDir, MANAGED_SKILLS_MANIFEST_FILE);
  const previousManifest = readInstalledManagedManifest(managedManifestPath);
  const previouslyManaged = new Set(previousManifest.skills);
  preflightInstalledTargets(paths.skillsDir, bundledManifest.skills, previousManifest.skills);

  const transactionParent = path.dirname(paths.skillsDir);
  const stageRoot = fs.mkdtempSync(path.join(transactionParent, SKILLS_STAGE_PREFIX));
  let backupRoot = null;
  let transactionSucceeded = false;
  const journalPath = path.join(transactionParent, SKILLS_TRANSACTION_JOURNAL_FILE);
  try {
    stageSecureSkills({ source, stageRoot, manifest: bundledManifest, copySkill });
    backupRoot = fs.mkdtempSync(path.join(transactionParent, SKILLS_BACKUP_PREFIX));
    writeFileAtomic(journalPath, `${JSON.stringify({
      schemaVersion: SKILLS_TRANSACTION_SCHEMA_VERSION,
      skillsDir: path.basename(paths.skillsDir),
      stageRoot: path.basename(stageRoot),
      backupRoot: path.basename(backupRoot),
      previousSkills: previousManifest.skills,
      incomingSkills: bundledManifest.skills,
      hadManagedManifest: fs.existsSync(managedManifestPath),
      hadLegacyManifest: isLegacyManifestFile(path.join(paths.skillsDir, LEGACY_SKILLS_MANIFEST_FILE))
    }, null, 2)}\n`, { mode: 0o600 });
    applySecureSkillsTransaction({
      skillsDir: paths.skillsDir,
      stageRoot,
      backupRoot,
      bundledManifest,
      previousManifest
    });
    transactionSucceeded = true;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    if (backupRoot && (transactionSucceeded || isEmptyDirectory(backupRoot))) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
    if (transactionSucceeded) fs.rmSync(journalPath, { force: true });
  }

  const removed = previousManifest.skills.filter((name) => !bundledManifest.skills.includes(name)).length;
  emit(`Installed ${bundledManifest.skills.length} managed secure skill${bundledManifest.skills.length === 1 ? "" : "s"}; removed ${removed} previously managed skill${removed === 1 ? "" : "s"}.`);
  return {
    installed: bundledManifest.skills.length,
    removed,
    source,
    previouslyManaged: Array.from(previouslyManaged).sort()
  };
}

function readBundledManifest(source) {
  assertBundledSkillsLicense(source);
  const manifestPath = path.join(source, VENDOR_SKILLS_MANIFEST_FILE);
  const manifest = readJsonManifest(manifestPath, "Bundled secure skills manifest");
  validateBundledSkillsProvenance(manifest);
  const validated = validateManagedSkillsManifest(manifest, "Bundled secure skills manifest");
  const packagedSkills = listPackagedSkillNames(source);
  if (!sameStringArray(validated.skills, packagedSkills)) {
    throw new Error(`Bundled secure skills manifest does not match its skill directories (manifest: ${validated.skills.join(", ") || "none"}; directories: ${packagedSkills.join(", ") || "none"}).`);
  }
  return validated;
}

function assertBundledSkillsLicense(source) {
  const licensePath = path.join(source, VENDOR_SKILLS_LICENSE_FILE);
  if (!fs.existsSync(licensePath)) {
    throw new Error(`Bundled secure skills license is missing: ${licensePath}`);
  }
  const stat = fs.lstatSync(licensePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Bundled secure skills license must be a regular file: ${licensePath}`);
  }
}

function validateBundledSkillsProvenance(manifest) {
  const repository = manifest && manifest.source && manifest.source.repo;
  assertCanonicalSecureSkillsRepository(repository, "Bundled secure skills manifest");
}

function readInstalledManagedManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return createManagedSkillsManifest([]);
  }
  const manifest = readJsonManifest(manifestPath, "Installed managed secure skills manifest");
  return validateManagedSkillsManifest(manifest, "Installed managed secure skills manifest");
}

function readJsonManifest(manifestPath, label) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${label} is missing: ${manifestPath}`);
  }
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${manifestPath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function listPackagedSkillNames(source) {
  return fs.readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      if (!isValidSkillName(entry.name)) {
        throw new Error(`Bundled secure skills contain invalid skill directory ${JSON.stringify(entry.name)}.`);
      }
      validatePackagedSkillDirectory(path.join(source, entry.name), entry.name);
      return entry.name;
    })
    .sort();
}

function validatePackagedSkillDirectory(skillDir, skillName) {
  const directoryStat = fs.lstatSync(skillDir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Bundled secure skill ${JSON.stringify(skillName)} must be a real directory.`);
  }
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Bundled secure skill ${JSON.stringify(skillName)} is missing SKILL.md.`);
  }
  const skillStat = fs.lstatSync(skillFile);
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error(`Bundled secure skill ${JSON.stringify(skillName)} must contain a regular SKILL.md file.`);
  }
  validateSkillTree(skillDir, `Bundled secure skill ${JSON.stringify(skillName)}`);
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

function preflightInstalledTargets(skillsDir, incomingSkills, previousSkills) {
  const previouslyManaged = new Set(previousSkills);

  for (const skillName of previousSkills) {
    const target = path.join(skillsDir, skillName);
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Previously managed secure skill ${JSON.stringify(skillName)} is not a real directory; refusing to replace or remove it.`);
    }
  }

  for (const skillName of incomingSkills) {
    const target = path.join(skillsDir, skillName);
    if (fs.existsSync(target) && !previouslyManaged.has(skillName)) {
      throw new Error(`Cannot install managed secure skill ${JSON.stringify(skillName)} because an existing unowned skill uses that name. Rename or remove the unowned skill, then retry.`);
    }
  }
}

function stageSecureSkills({ source, stageRoot, manifest, copySkill }) {
  for (const skillName of manifest.skills) {
    const sourceSkill = path.join(source, skillName);
    const stagedSkill = path.join(stageRoot, skillName);
    copySkill(sourceSkill, stagedSkill);
    validatePackagedSkillDirectory(stagedSkill, skillName);
  }
  fs.writeFileSync(
    path.join(stageRoot, MANAGED_SKILLS_MANIFEST_FILE),
    `${JSON.stringify(createManagedSkillsManifest(manifest.skills), null, 2)}\n`
  );
}

function copySkillDirectory(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (entry) => !entry.includes(`${path.sep}.git${path.sep}`)
      && !entry.endsWith(`${path.sep}.git`)
      && path.basename(entry) !== ".DS_Store"
  });
}

function applySecureSkillsTransaction({ skillsDir, stageRoot, backupRoot, bundledManifest, previousManifest }) {
  const managedManifestPath = path.join(skillsDir, MANAGED_SKILLS_MANIFEST_FILE);
  const legacyManifestPath = path.join(skillsDir, LEGACY_SKILLS_MANIFEST_FILE);
  const stagedManifestPath = path.join(stageRoot, MANAGED_SKILLS_MANIFEST_FILE);
  const backedUpSkills = [];
  const activatedSkills = [];
  let backedUpManagedManifest = false;
  let backedUpLegacyManifest = false;
  let replacementManifestActivated = false;

  try {
    for (const skillName of previousManifest.skills) {
      const installedPath = path.join(skillsDir, skillName);
      if (!fs.existsSync(installedPath)) continue;
      fs.renameSync(installedPath, path.join(backupRoot, skillName));
      backedUpSkills.push(skillName);
    }

    if (fs.existsSync(managedManifestPath)) {
      fs.renameSync(managedManifestPath, path.join(backupRoot, MANAGED_SKILLS_MANIFEST_FILE));
      backedUpManagedManifest = true;
    }
    if (isLegacyManifestFile(legacyManifestPath)) {
      fs.renameSync(legacyManifestPath, path.join(backupRoot, LEGACY_SKILLS_MANIFEST_FILE));
      backedUpLegacyManifest = true;
    }

    for (const skillName of bundledManifest.skills) {
      fs.renameSync(path.join(stageRoot, skillName), path.join(skillsDir, skillName));
      activatedSkills.push(skillName);
    }
    fs.renameSync(stagedManifestPath, managedManifestPath);
    replacementManifestActivated = true;
  } catch (error) {
    const rollbackErrors = rollbackSecureSkillsTransaction({
      skillsDir,
      backupRoot,
      backedUpSkills,
      activatedSkills,
      backedUpManagedManifest,
      backedUpLegacyManifest,
      replacementManifestActivated
    });
    const rollbackSuffix = rollbackErrors.length > 0
      ? ` Rollback also reported: ${rollbackErrors.join("; ")}`
      : "";
    throw new Error(`Managed secure skills install failed before completion: ${error.message}.${rollbackSuffix}`);
  }
}

function rollbackSecureSkillsTransaction({
  skillsDir,
  backupRoot,
  backedUpSkills,
  activatedSkills,
  backedUpManagedManifest,
  backedUpLegacyManifest,
  replacementManifestActivated
}) {
  const errors = [];
  const attempt = (description, action) => {
    try {
      action();
    } catch (error) {
      errors.push(`${description}: ${error.message}`);
    }
  };

  if (replacementManifestActivated) {
    attempt("remove replacement ownership manifest", () => {
      fs.rmSync(path.join(skillsDir, MANAGED_SKILLS_MANIFEST_FILE), { force: true });
    });
  }
  for (const skillName of activatedSkills.reverse()) {
    attempt(`remove replacement ${skillName}`, () => {
      fs.rmSync(path.join(skillsDir, skillName), { recursive: true, force: true });
    });
  }
  for (const skillName of backedUpSkills) {
    attempt(`restore previous ${skillName}`, () => {
      fs.renameSync(path.join(backupRoot, skillName), path.join(skillsDir, skillName));
    });
  }
  if (backedUpManagedManifest) {
    attempt("restore previous ownership manifest", () => {
      fs.renameSync(
        path.join(backupRoot, MANAGED_SKILLS_MANIFEST_FILE),
        path.join(skillsDir, MANAGED_SKILLS_MANIFEST_FILE)
      );
    });
  }
  if (backedUpLegacyManifest) {
    attempt("restore legacy manifest", () => {
      fs.renameSync(
        path.join(backupRoot, LEGACY_SKILLS_MANIFEST_FILE),
        path.join(skillsDir, LEGACY_SKILLS_MANIFEST_FILE)
      );
    });
  }
  return errors;
}

function recoverInterruptedSkillsTransaction(skillsDir, emit: InstallerEmit = () => {}) {
  const transactionParent = path.dirname(skillsDir);
  const journalPath = path.join(transactionParent, SKILLS_TRANSACTION_JOURNAL_FILE);
  if (!fs.existsSync(journalPath)) return { recovered: false };

  const journal = readSkillsTransactionJournal(journalPath, skillsDir);
  const stageRoot = resolveTransactionDirectory(transactionParent, journal.stageRoot, SKILLS_STAGE_PREFIX);
  const backupRoot = resolveTransactionDirectory(transactionParent, journal.backupRoot, SKILLS_BACKUP_PREFIX);

  if (skillsStateMatches(skillsDir, journal.incomingSkills, journal.previousSkills)) {
    removeSkillsTransactionArtifacts({ journalPath, stageRoot, backupRoot });
    emit("Recovered a completed managed secure skills transaction after an interrupted cleanup.");
    return { recovered: true, action: "committed" };
  }

  if (skillsStateMatches(skillsDir, journal.previousSkills, journal.incomingSkills)) {
    removeSkillsTransactionArtifacts({ journalPath, stageRoot, backupRoot });
    emit("Cleaned an interrupted managed secure skills transaction after its rollback completed.");
    return { recovered: true, action: "already-rolled-back" };
  }

  rollbackInterruptedSkillsTransaction({ skillsDir, stageRoot, backupRoot, journal });
  if (!skillsStateMatches(skillsDir, journal.previousSkills, journal.incomingSkills)) {
    throw new Error(
      `Could not recover the interrupted managed secure skills transaction at ${journalPath}; `
      + "the previous managed bundle could not be proven intact. Transaction evidence was preserved."
    );
  }
  removeSkillsTransactionArtifacts({ journalPath, stageRoot, backupRoot });
  emit("Restored the previous managed secure skills bundle after an interrupted transaction.");
  return { recovered: true, action: "rolled-back" };
}

function readSkillsTransactionJournal(journalPath, skillsDir) {
  const stat = fs.lstatSync(journalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Managed secure skills transaction journal must be a regular file: ${journalPath}`);
  }

  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`Managed secure skills transaction journal is invalid JSON: ${error.message}`);
  }

  const validSkillList = (value) => Array.isArray(value)
    && value.every((name) => typeof name === "string" && isValidSkillName(name))
    && new Set(value).size === value.length;
  if (!isPlainObject(journal)
    || journal.schemaVersion !== SKILLS_TRANSACTION_SCHEMA_VERSION
    || journal.skillsDir !== path.basename(skillsDir)
    || typeof journal.stageRoot !== "string"
    || typeof journal.backupRoot !== "string"
    || !validSkillList(journal.previousSkills)
    || !validSkillList(journal.incomingSkills)
    || typeof journal.hadManagedManifest !== "boolean"
    || typeof journal.hadLegacyManifest !== "boolean") {
    throw new Error(`Managed secure skills transaction journal has an invalid schema: ${journalPath}`);
  }
  return journal;
}

function resolveTransactionDirectory(parent, name, prefix) {
  if (path.basename(name) !== name || !name.startsWith(prefix)) {
    throw new Error(`Managed secure skills transaction contains an unsafe directory name: ${name}`);
  }
  const directory = path.join(parent, name);
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Managed secure skills transaction path must be a real directory: ${directory}`);
    }
  }
  return directory;
}

function skillsStateMatches(skillsDir, expectedSkills, absentManagedSkills) {
  const manifestPath = path.join(skillsDir, MANAGED_SKILLS_MANIFEST_FILE);
  let installedSkills;
  if (!fs.existsSync(manifestPath)) {
    installedSkills = [];
  } else {
    try {
      installedSkills = readInstalledManagedManifest(manifestPath).skills;
    } catch (_error) {
      return false;
    }
  }
  if (!sameStringArray(installedSkills, expectedSkills)) return false;

  try {
    for (const skillName of expectedSkills) {
      validatePackagedSkillDirectory(path.join(skillsDir, skillName), skillName);
    }
  } catch (_error) {
    return false;
  }
  return absentManagedSkills
    .filter((name) => !expectedSkills.includes(name))
    .every((name) => !fs.existsSync(path.join(skillsDir, name)));
}

function rollbackInterruptedSkillsTransaction({ skillsDir, stageRoot, backupRoot, journal }) {
  const previous = new Set(journal.previousSkills);
  const incoming = new Set(journal.incomingSkills);
  const allSkills = Array.from(new Set([...journal.previousSkills, ...journal.incomingSkills]));

  for (const skillName of allSkills) {
    const target = path.join(skillsDir, skillName);
    const staged = path.join(stageRoot, skillName);
    const backup = path.join(backupRoot, skillName);
    if (fs.existsSync(backup)) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(backup, target);
      continue;
    }
    if (!previous.has(skillName) && incoming.has(skillName) && !fs.existsSync(staged)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  restoreInterruptedManifest({
    target: path.join(skillsDir, MANAGED_SKILLS_MANIFEST_FILE),
    staged: path.join(stageRoot, MANAGED_SKILLS_MANIFEST_FILE),
    backup: path.join(backupRoot, MANAGED_SKILLS_MANIFEST_FILE),
    existedBefore: journal.hadManagedManifest
  });
  restoreInterruptedManifest({
    target: path.join(skillsDir, LEGACY_SKILLS_MANIFEST_FILE),
    staged: null,
    backup: path.join(backupRoot, LEGACY_SKILLS_MANIFEST_FILE),
    existedBefore: journal.hadLegacyManifest
  });
}

function restoreInterruptedManifest({ target, staged, backup, existedBefore }) {
  if (fs.existsSync(backup)) {
    fs.rmSync(target, { force: true });
    fs.renameSync(backup, target);
    return;
  }
  if (!existedBefore && staged && !fs.existsSync(staged)) {
    fs.rmSync(target, { force: true });
  }
}

function removeSkillsTransactionArtifacts({ journalPath, stageRoot, backupRoot }) {
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
}

function isLegacyManifestFile(manifestPath) {
  if (!fs.existsSync(manifestPath)) return false;
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!isPlainObject(manifest) || !hasOnlyKeys(manifest, ["source", "skills"])) return false;
    if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) return false;
    if (!manifest.skills.every((name) => typeof name === "string" && isValidSkillName(name))) {
      return false;
    }
    if (!isPlainObject(manifest.source)) return false;

    if (manifest.source.type === "git") {
      if (!hasOnlyKeys(manifest.source, ["type", "repo", "ref", "commit"])) return false;
      return isLegacyPublicRepository(manifest.source.repo);
    }
    if (manifest.source.type === "local") {
      if (!hasOnlyKeys(manifest.source, ["type", "path", "commit", "dirty"])) return false;
      return isLegacyPublicRepository(manifest.source.path);
    }
    return false;
  } catch (_error) {
    return false;
  }
}

function isLegacyPublicRepository(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const basename = normalized.split(/[\\/]/).at(-1);
  return basename?.toLowerCase() === "ucsd-skills-library";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isEmptyDirectory(directory: string): boolean {
  return fs.existsSync(directory)
    && fs.lstatSync(directory).isDirectory()
    && fs.readdirSync(directory).length === 0;
}

function findBundledSkillsDir(options: SkillsBundleOptions = {}): string | null {
  const candidates = bundleBaseCandidates(options)
    .map((base) => path.join(base, "vendor", "skills"));

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || null;
}

function bundleBaseCandidates(options: SkillsBundleOptions = {}): string[] {
  const explicitResourcesPath = options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath;
  const appRoot = options.appRoot || defaultAppRoot(__dirname);

  return [
    explicitResourcesPath && path.join(explicitResourcesPath, "app"),
    explicitResourcesPath,
    appRoot
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function listSkillDirs(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")))
    .sort();
}

module.exports = {
  LEGACY_SKILLS_MANIFEST_FILE,
  MANAGED_SKILLS_MANIFEST_FILE,
  SKILLS_TRANSACTION_JOURNAL_FILE,
  VENDOR_SKILLS_MANIFEST_FILE,
  VENDOR_SKILLS_LICENSE_FILE,
  findBundledSkillsDir,
  installBundledSkills,
  listSkillDirs,
  readBundledManifest,
  readInstalledManagedManifest,
  recoverInterruptedSkillsTransaction
};
