const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withCodexRuntimeLock, CODEX_RUNTIME_LOCK, HARNESS_UPDATE_JOURNAL } = require("../src/installer/codex-runtime-lock");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-codex-lock-test-"));
  try {
    const lockPath = path.join(root, CODEX_RUNTIME_LOCK);
    const probe = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); try { db.exec('BEGIN EXCLUSIVE'); console.log('acquired'); db.exec('ROLLBACK'); } catch(e) { if(e.errcode!==5) throw e; console.log('busy'); } finally { db.close(); }`;
    await withCodexRuntimeLock(root, async () => {
      const child = spawnSync(process.execPath, ["-e", probe, lockPath], { encoding: "utf8", timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /busy/);
      await assert.rejects(withCodexRuntimeLock(root, async () => assert.fail("nested update must not run")), /Another TritonAI operation/);
    });
    const released = spawnSync(process.execPath, ["-e", probe, lockPath], { encoding: "utf8", timeout: 10000 });
    assert.equal(released.status, 0, released.stderr);
    assert.match(released.stdout, /acquired/);
    await assert.rejects(withCodexRuntimeLock(root, async () => { throw new Error("simulated install failure"); }), /simulated install failure/);
    await withCodexRuntimeLock(root, async () => {});
    assert(fs.existsSync(lockPath), "the lock file must persist");

    const journal = { schemaVersion: 1, targetName: "openai-codex-0.146.0", stageName: ".tritonai-codex-stage.test", backupName: ".tritonai-codex-backup.test", committed: false };
    const target = path.join(root, journal.targetName);
    const backup = path.join(root, journal.backupName, journal.targetName);
    const stage = path.join(root, journal.stageName);
    for (const committed of [false, true]) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "version"), "new");
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, "version"), "old");
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(root, HARNESS_UPDATE_JOURNAL), JSON.stringify({ ...journal, committed }));
      await withCodexRuntimeLock(root, async () => {
        assert.equal(fs.readFileSync(path.join(target, "version"), "utf8"), committed ? "new" : "old");
        assert(!fs.existsSync(path.join(root, HARNESS_UPDATE_JOURNAL)));
      });
    }
    fs.writeFileSync(path.join(root, HARNESS_UPDATE_JOURNAL), JSON.stringify({ ...journal, backupName: "../outside" }));
    await assert.rejects(withCodexRuntimeLock(root, async () => assert.fail("invalid journal must stop installation")), /invalid path/);
    assert.equal(fs.readFileSync(path.join(target, "version"), "utf8"), "new");
    console.log("Codex runtime cross-process lock and recovery tests passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
