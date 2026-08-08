const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./atomic-file");

const DIRECTORY_TRANSACTION_SCHEMA_VERSION = 1;

function writeDirectoryTransactionJournal({
  journalPath,
  kind,
  target,
  stageRoot,
  backupRoot,
  stagePrefix,
  backupPrefix,
  stagedName,
  backupName,
  hadPrevious
}) {
  const parent = path.dirname(target);
  assertTransactionDirectory(parent, stageRoot, stagePrefix);
  assertTransactionDirectory(parent, backupRoot, backupPrefix);
  assertSafeName(stagedName, "staged payload");
  assertSafeName(backupName, "backup payload");
  writeFileAtomic(journalPath, `${JSON.stringify({
    schemaVersion: DIRECTORY_TRANSACTION_SCHEMA_VERSION,
    kind,
    targetName: path.basename(target),
    stageRoot: path.basename(stageRoot),
    backupRoot: path.basename(backupRoot),
    stagedName,
    backupName,
    hadPrevious: Boolean(hadPrevious)
  }, null, 2)}\n`, { mode: 0o600 });
}

function recoverInterruptedDirectoryTransaction({
  journalPath,
  kind,
  target,
  stagePrefix,
  backupPrefix,
  validate,
  emit = (() => {}) as InstallerEmit
}) {
  if (!fs.existsSync(journalPath)) return { recovered: false };
  const parent = path.dirname(target);
  const journal = readDirectoryTransactionJournal(journalPath, { kind, target });
  const stageRoot = resolveTransactionDirectory(parent, journal.stageRoot, stagePrefix);
  const backupRoot = resolveTransactionDirectory(parent, journal.backupRoot, backupPrefix);
  const staged = path.join(stageRoot, journal.stagedName);
  const backup = path.join(backupRoot, journal.backupName);

  if (isValid(validate, target)) {
    removeTransactionArtifacts({ journalPath, stageRoot, backupRoot });
    emit(`Recovered completed ${kind} activation after interrupted cleanup.`);
    return { recovered: true, action: "committed" };
  }

  if (journal.hadPrevious && isValid(validate, backup)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(backup, target);
    if (!isValid(validate, target)) {
      throw new Error(`Could not prove the restored ${kind} payload at ${target}; transaction evidence was preserved.`);
    }
    removeTransactionArtifacts({ journalPath, stageRoot, backupRoot });
    emit(`Restored the previous ${kind} payload after an interrupted activation.`);
    return { recovered: true, action: "rolled-back" };
  }

  if (!journal.hadPrevious) {
    fs.rmSync(target, { recursive: true, force: true });
    removeTransactionArtifacts({ journalPath, stageRoot, backupRoot });
    emit(`Cleared an interrupted first-time ${kind} activation so it can be retried cleanly.`);
    return { recovered: true, action: "reset" };
  }

  throw new Error(
    `Could not recover interrupted ${kind} activation at ${journalPath}; neither the active nor backup payload is valid. `
    + `The staged path ${staged} and transaction evidence were preserved.`
  );
}

function readDirectoryTransactionJournal(journalPath, { kind, target }) {
  const stat = fs.lstatSync(journalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${kind} transaction journal must be a regular file: ${journalPath}`);
  }
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`${kind} transaction journal is invalid JSON: ${error.message}`);
  }
  if (!journal
    || typeof journal !== "object"
    || Array.isArray(journal)
    || journal.schemaVersion !== DIRECTORY_TRANSACTION_SCHEMA_VERSION
    || journal.kind !== kind
    || journal.targetName !== path.basename(target)
    || typeof journal.stageRoot !== "string"
    || typeof journal.backupRoot !== "string"
    || typeof journal.stagedName !== "string"
    || typeof journal.backupName !== "string"
    || typeof journal.hadPrevious !== "boolean") {
    throw new Error(`${kind} transaction journal has an invalid schema: ${journalPath}`);
  }
  assertSafeName(journal.stagedName, "staged payload");
  assertSafeName(journal.backupName, "backup payload");
  return journal;
}

function assertTransactionDirectory(parent, directory, prefix) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(parent)
    || !path.basename(directory).startsWith(prefix)) {
    throw new Error(`Unsafe managed transaction directory: ${directory}`);
  }
}

function resolveTransactionDirectory(parent, name, prefix) {
  assertSafeName(name, "transaction directory");
  if (!name.startsWith(prefix)) throw new Error(`Unsafe managed transaction directory name: ${name}`);
  const directory = path.join(parent, name);
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Managed transaction path must be a real directory: ${directory}`);
    }
  }
  return directory;
}

function assertSafeName(name, label) {
  if (!name || path.basename(name) !== name || name === "." || name === "..") {
    throw new Error(`Unsafe ${label} name in managed transaction: ${name}`);
  }
}

function isValid(validate, candidate) {
  try {
    return fs.existsSync(candidate) && Boolean(validate(candidate));
  } catch (_error) {
    return false;
  }
}

function removeTransactionArtifacts({ journalPath, stageRoot, backupRoot }) {
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
}

module.exports = {
  DIRECTORY_TRANSACTION_SCHEMA_VERSION,
  recoverInterruptedDirectoryTransaction,
  writeDirectoryTransactionJournal
};
