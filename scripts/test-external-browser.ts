const assert = require("assert");
const { EventEmitter } = require("events");
const { openUrlInDefaultBrowser } = require("../src/external-browser");

async function main() {
  await assertPrimaryLaunchIsUsed();
  await assertWindowsFallbackUsesExplorer();
  await assertNonWindowsFailureIsPreserved();
  await assertWindowsFallbackFailureIsReported();
  console.log("External browser launch tests passed.");
}

async function assertPrimaryLaunchIsUsed() {
  const opened = [];
  let fallbackCalled = false;

  await openUrlInDefaultBrowser("https://example.invalid/request?source=installer", {
    platform: "win32",
    openExternal: async (url) => opened.push(url),
    spawn: (() => {
      fallbackCalled = true;
      throw new Error("fallback should not run");
    })
  });

  assert.deepStrictEqual(opened, ["https://example.invalid/request?source=installer"]);
  assert.strictEqual(fallbackCalled, false);
}

async function assertWindowsFallbackUsesExplorer() {
  const launches = [];
  let unrefCalled = false;

  await openUrlInDefaultBrowser("https://example.invalid/request?first=1&second=2", {
    platform: "win32",
    openExternal: async () => {
      throw new Error("simulated Electron launch failure");
    },
    spawn: ((command, args, options) => {
      launches.push({ command, args, options });
      return spawnedChild(() => {
        unrefCalled = true;
      });
    })
  });

  assert.deepStrictEqual(launches, [{
    command: "explorer.exe",
    args: ["https://example.invalid/request?first=1&second=2"],
    options: {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  }]);
  assert.strictEqual(unrefCalled, true);
}

async function assertNonWindowsFailureIsPreserved() {
  const launchError = new Error("simulated macOS launch failure");

  await assert.rejects(
    openUrlInDefaultBrowser("https://example.invalid/request", {
      platform: "darwin",
      openExternal: async () => {
        throw launchError;
      },
      spawn: (() => {
        throw new Error("fallback should not run");
      })
    }),
    (error) => error === launchError
  );
}

async function assertWindowsFallbackFailureIsReported() {
  const fallbackError = new Error("explorer.exe was unavailable");

  await assert.rejects(
    openUrlInDefaultBrowser("https://example.invalid/request", {
      platform: "win32",
      openExternal: async () => {
        throw new Error("simulated Electron launch failure");
      },
      spawn: (() => spawnedChild(undefined, fallbackError))
    }),
    (error) => error === fallbackError
  );
}

function spawnedChild(onUnref, error = null) {
  const child = new EventEmitter();
  child.unref = () => onUnref?.();
  process.nextTick(() => child.emit(error ? "error" : "spawn", error));
  return child;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
