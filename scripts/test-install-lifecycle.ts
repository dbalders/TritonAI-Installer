const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { InstallLifecycle } = require("../src/install-lifecycle");
const { acquireSingleInstance } = require("../src/single-instance");
const { terminateProcessTree } = require("../src/installer/process-termination");
const {
  runDesktopCommand,
  runDesktopCommandCapture
} = require("../src/installer/t3code-desktop");
const { readWindowsEnvironmentVariable } = require("../src/installer/existing-api-key");
const { runPowerShell: runEnvironmentMigrationPowerShell } = require("../src/installer/windows-environment-migration");
const {
  createDiagnosticEmitter,
  notifyDiagnosticsSafely,
  normalizeInstallError,
  runCommand,
  runCommandForOutput,
  writeSupportReportSafely
} = require("../src/installer/runner");

async function main() {
  assertSingleInstanceOwnership();
  const lifecycle = new InstallLifecycle();
  assert.strictEqual(lifecycle.isInstallInProgress(), false);
  assert.strictEqual(lifecycle.shouldBlockExit(), false);

  lifecycle.beginInstall();
  assert.strictEqual(lifecycle.isInstallInProgress(), true);
  assert.strictEqual(lifecycle.shouldBlockExit(), true);
  assert.throws(() => lifecycle.beginInstall(), /already running/);

  lifecycle.endInstall();
  assert.strictEqual(lifecycle.shouldBlockExit(), false);
  lifecycle.beginInstall();
  assert.strictEqual(lifecycle.requestFinish(), true);
  assert.strictEqual(lifecycle.requestFinish(), false);
  assert.strictEqual(lifecycle.shouldBlockExit(), false);
  lifecycle.endInstall();

  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    const emit = createDiagnosticEmitter(
      () => { throw new Error("renderer unavailable"); },
      { append: () => { throw new Error("log unavailable"); } }
    );
    assert.doesNotThrow(() => emit("install continues"));
    assert.strictEqual(errors.length, 2);
    const fallback = writeSupportReportSafely({
      writeSupportReport: () => { throw new Error("report unavailable"); },
      fallbackInfo: (ok) => ({ ok, reportAvailable: false })
    }, { ok: true });
    assert.deepStrictEqual(fallback, { ok: true, reportAvailable: false });
    assert.doesNotThrow(() => notifyDiagnosticsSafely(
      () => { throw new Error("metadata observer unavailable"); },
      { ok: true }
    ));
    assert.strictEqual(errors.length, 4);
  } finally {
    console.error = originalConsoleError;
  }

  assert.strictEqual(normalizeInstallError("plain failure").message, "plain failure");
  const originalError = new Error("typed failure");
  assert.strictEqual(normalizeInstallError(originalError), originalError);

  const timeoutCommand = ["-e", "setInterval(() => {}, 1000)"];
  // Windows process creation can exceed 50ms on loaded CI runners. Give the
  // fixture time to become a stable taskkill target while keeping the test
  // timeout far below production command limits.
  const timeoutMs = process.platform === "win32" ? 500 : 50;
  await assert.rejects(
    runCommand(process.execPath, timeoutCommand, { emit: () => {}, env: process.env, timeoutMs }),
    (error) => error.code === "ETIMEDOUT" && /process tree was terminated/.test(error.message)
  );
  const timeoutEvents = [];
  await runCommand(process.execPath, timeoutCommand, {
    emit: (message) => timeoutEvents.push(message),
    env: process.env,
    timeoutMs,
    allowFailure: true
  });
  assert(timeoutEvents.some((message) => message.includes(`timed out after ${timeoutMs}ms`)));
  await assert.rejects(
    runCommandForOutput(process.execPath, timeoutCommand, {
      env: process.env,
      timeoutMs
    }),
    (error) => error.code === "ETIMEDOUT" && /process tree was terminated/.test(error.message)
  );
  await assert.rejects(
    runCommand(process.execPath, timeoutCommand, {
      emit: () => {},
      env: process.env,
      timeoutMs,
      allowFailure: true,
      terminate: async (child, options) => {
        await terminateProcessTree(child, options);
        throw new Error("simulated termination confirmation failure");
      }
    }),
    /termination could not be confirmed/
  );
  await assertCommandTimeoutTerminatesDescendants();
  await assertExitedLeaderStillTerminatesProcessGroup();
  await assert.rejects(
    runDesktopCommand(process.execPath, timeoutCommand, () => {}, { timeoutMs }),
    (error) => error.code === "ETIMEDOUT" && /process tree was terminated/.test(error.message)
  );
  await assert.rejects(
    runDesktopCommandCapture(process.execPath, timeoutCommand, () => {}, { timeoutMs }),
    (error) => error.code === "ETIMEDOUT" && /process tree was terminated/.test(error.message)
  );
  const spawnTimedOutFixture = () => spawn(process.execPath, timeoutCommand, {
    detached: process.platform !== "win32"
  });
  const terminateFixture = (child) => terminateProcessTree(child, {
    platform: process.platform,
    graceMs: 500
  });
  assert.strictEqual(await readWindowsEnvironmentVariable("TRITONAI_API_KEY", "User", {
    timeoutMs,
    spawnProcess: spawnTimedOutFixture,
    terminate: terminateFixture
  }), "");
  await assert.rejects(
    runEnvironmentMigrationPowerShell("Write-Output fixture", "testing the cleanup watchdog", {
      platform: "win32",
      timeoutMs,
      spawnProcess: spawnTimedOutFixture,
      terminate: terminateFixture
    }),
    (error) => error.code === "ETIMEDOUT" && /process tree was terminated/.test(error.message)
  );

  console.log("Installer lifecycle tests passed.");
}

async function assertExitedLeaderStillTerminatesProcessGroup() {
  if (process.platform === "win32") return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-exited-leader-"));
  const pidFile = path.join(tempRoot, "descendant.pid");
  const script = [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "child.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`
  ].join(" ");
  const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => {
      leader.once("error", reject);
      leader.once("exit", resolve);
    });
    assert(fs.existsSync(pidFile), "exited-leader fixture must record its descendant PID");
    const descendantPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    assert.strictEqual(isProcessRunning(descendantPid), true, "fixture descendant must outlive its process-group leader");
    await terminateProcessTree(leader, { graceMs: 500 });
    const deadline = Date.now() + 3_000;
    while (isProcessRunning(descendantPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.strictEqual(isProcessRunning(descendantPid), false, "termination must inspect the process group even after its leader exits");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertCommandTimeoutTerminatesDescendants() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-process-tree-"));
  const pidFile = path.join(tempRoot, "grandchild.pid");
  const script = [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "setInterval(() => {}, 1000);"
  ].join(" ");
  try {
    await assert.rejects(
      runCommand(process.execPath, ["-e", script], {
        emit: () => {},
        env: process.env,
        timeoutMs: 500
      }),
      (error) => error.code === "ETIMEDOUT"
    );
    assert(fs.existsSync(pidFile), "timeout fixture must record its descendant PID");
    const descendantPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    const deadline = Date.now() + 3_000;
    while (isProcessRunning(descendantPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.strictEqual(isProcessRunning(descendantPid), false, "timed-out command descendants must be terminated before rejection");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
}

function assertSingleInstanceOwnership() {
  const listeners = new Map();
  let quitCount = 0;
  let secondInstanceCount = 0;
  const primary = {
    requestSingleInstanceLock: () => true,
    on: (event, listener) => listeners.set(event, listener),
    quit: () => { quitCount += 1; }
  };
  assert.strictEqual(acquireSingleInstance(primary, () => { secondInstanceCount += 1; }), true);
  assert.strictEqual(quitCount, 0);
  listeners.get("second-instance")();
  assert.strictEqual(secondInstanceCount, 1);

  const secondary = {
    requestSingleInstanceLock: () => false,
    on: () => { throw new Error("a secondary process must not register listeners"); },
    quit: () => { quitCount += 1; }
  };
  assert.strictEqual(acquireSingleInstance(secondary, () => {}), false);
  assert.strictEqual(quitCount, 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
