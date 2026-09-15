const fs = require("node:fs");
const path = require("node:path");

// Shared with Harness managedCodexTransaction.ts. The lock file is never deleted.
const CODEX_RUNTIME_LOCK = ".tritonai-codex.lock.sqlite";
const HARNESS_UPDATE_JOURNAL = ".tritonai-codex-update.json";
const localLocks = new Set<string>();

async function withCodexRuntimeLock<T>(runtimeRoot: string, operation: () => Promise<T>): Promise<T> {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const canonicalRoot = fs.realpathSync.native(runtimeRoot);
  const lockPath = path.join(canonicalRoot, CODEX_RUNTIME_LOCK);
  const key = process.platform === "linux" ? lockPath : lockPath.normalize("NFC").toLowerCase();
  if (localLocks.has(key)) throw new Error("Another TritonAI operation is updating Codex. Retry when it finishes.");
  localLocks.add(key);
  let fd: number | undefined;
  let database: import("node:sqlite").DatabaseSync | undefined;
  let acquired = false;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | noFollow, 0o600);
    const opened = fs.fstatSync(fd);
    const entry = fs.lstatSync(lockPath);
    if (!opened.isFile() || opened.nlink !== 1 || entry.isSymbolicLink()
      || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new Error("The shared Codex lock must be a regular file.");
    }
    fs.fchmodSync(fd, 0o600);
    database = new DatabaseSync(lockPath);
    database.exec("BEGIN EXCLUSIVE");
    acquired = true;
    recoverHarnessCodexUpdate(canonicalRoot);
    return await operation();
  } catch (error) {
    if (error?.errcode === 5) {
      throw new Error("Another Harness app or TritonAI Installer is updating Codex. Retry when it finishes.");
    }
    throw error;
  } finally {
    try {
      if (acquired) database.exec("ROLLBACK");
    } finally {
      try { database?.close(); }
      finally {
        try { if (fd !== undefined) fs.closeSync(fd); }
        finally { localLocks.delete(key); }
      }
    }
  }
}

/** Conservatively restore an interrupted Harness update before the Installer changes the runtime. */
function recoverHarnessCodexUpdate(runtimeRoot: string): void {
  const journalPath = path.join(runtimeRoot, HARNESS_UPDATE_JOURNAL);
  if (!fs.existsSync(journalPath)) return;
  if (fs.lstatSync(journalPath).isSymbolicLink()) throw new Error("The Codex recovery journal must be a regular file.");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (journal?.schemaVersion !== 1 || typeof journal.committed !== "boolean") {
    throw new Error("The Codex recovery journal is invalid. Recovery files have been preserved.");
  }
  for (const [name, pattern] of [
    [journal.targetName, /^openai-codex-[a-z0-9][a-z0-9._-]*$/u],
    [journal.stageName, /^\.tritonai-codex-stage\.[a-zA-Z0-9_-]+$/u],
    [journal.backupName, /^\.tritonai-codex-backup\.[a-zA-Z0-9_-]+$/u],
  ] as const) {
    if (typeof name !== "string" || !pattern.test(name) || path.basename(name) !== name) {
      throw new Error("The Codex recovery journal contains an invalid path. Recovery files have been preserved.");
    }
    const candidate = path.join(runtimeRoot, name);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error("A Codex recovery directory is a symbolic link. Recovery files have been preserved.");
    }
  }
  const target = path.join(runtimeRoot, journal.targetName);
  const stageRoot = path.join(runtimeRoot, journal.stageName);
  const backupRoot = path.join(runtimeRoot, journal.backupName);
  const backup = path.join(backupRoot, journal.targetName);
  if (!journal.committed && fs.existsSync(backup)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(backup, target);
  }
  if (!fs.existsSync(target)) throw new Error("Codex recovery could not find the previous runtime. Recovery files have been preserved.");
  fs.rmSync(journalPath);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(backupRoot, { recursive: true, force: true });
}

module.exports = { withCodexRuntimeLock, CODEX_RUNTIME_LOCK, HARNESS_UPDATE_JOURNAL };
