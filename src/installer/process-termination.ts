const { spawn } = require("child_process");
const path = require("path");

const DEFAULT_TERMINATION_GRACE_MS = 5_000;

async function terminateProcessTree(child, {
  platform = process.platform,
  graceMs = DEFAULT_TERMINATION_GRACE_MS,
  spawnProcess = spawn
} = {}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    if (hasExited(child)) return;
    throw terminationError("Timed-out process has no valid PID; termination cannot be confirmed.");
  }

  if (platform === "win32") {
    const taskkillPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const taskkill = await runTerminator(spawnProcess, taskkillPath, [
      "/pid",
      String(child.pid),
      "/t",
      "/f"
    ], graceMs);
    const closed = await waitForExit(child, graceMs);
    if (taskkill !== 0 || !closed) {
      throw terminationError(
        `Could not confirm termination of Windows process tree ${child.pid} (taskkill exit ${taskkill}).`
      );
    }
    return;
  }

  if (!processGroupExists(child.pid)) {
    if (hasExited(child)) return;
    throw terminationError(`Could not locate process group ${child.pid} for a still-running process.`);
  }
  signalProcessGroup(child.pid, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, graceMs)) return;
  signalProcessGroup(child.pid, "SIGKILL");
  if (await waitForProcessGroupExit(child.pid, graceMs)) return;
  throw terminationError(`Could not confirm termination of process group ${child.pid}.`);
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error && error.code === "ESRCH") return;
    throw terminationError(`Could not send ${signal} to process group ${pid}: ${error.message}`);
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    if (error && error.code === "EPERM") return true;
    throw terminationError(`Could not inspect process group ${pid}: ${error.message}`);
  }
}

function waitForProcessGroupExit(pid, timeoutMs) {
  if (!processGroupExists(pid)) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      let exists;
      try {
        exists = processGroupExists(pid);
      } catch (error) {
        reject(error);
        return;
      }
      if (!exists) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, Math.min(50, Math.max(1, deadline - Date.now())));
    };
    check();
  });
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(exited);
    };
    child.once("close", onClose);
  });
}

function runTerminator(spawnProcess, command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let processHandle;
    try {
      processHandle = spawnProcess(command, args, { shell: false, stdio: "ignore" });
    } catch (error) {
      reject(terminationError(`Could not launch ${command}: ${error.message}`));
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (error, code = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(code);
    };
    timer = setTimeout(() => {
      try { processHandle.kill(); } catch {}
      finish(terminationError(`${command} did not finish within ${timeoutMs}ms.`));
    }, timeoutMs);
    processHandle.once("error", (error) => finish(terminationError(`Could not run ${command}: ${error.message}`)));
    processHandle.once("close", (code) => finish(null, code));
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function terminationError(message) {
  return Object.assign(new Error(message), { code: "ETERMINATE" });
}

module.exports = {
  DEFAULT_TERMINATION_GRACE_MS,
  terminateProcessTree
};
