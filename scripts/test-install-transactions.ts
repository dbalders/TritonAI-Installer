const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { CODEX_CLI_VERSION } = require("../src/installer/npm-policy");
const {
  isCodexVendorDir,
  stageAndActivateBundledCodex,
  writeManagedCodexLauncher
} = require("../src/installer/codex-vendor");
const { getPaths } = require("../src/installer/paths");
const { getNodeRuntimePaths } = require("../src/installer/prerequisites");
const {
  getManagedMacAppPath,
  replaceMacAppTransactionally,
  writeMacAppLauncher
} = require("../src/installer/t3code-desktop");

async function main() {
  await assertMacReplacementStagesBeforeSwapAndRollsBack();
  assertMacLauncherStagesBeforeSwapAndRollsBack();
  assertCodexVendorIdentityIsRequired();
  assertCodexReplacementStagesBeforeSwapAndRollsBack();
  if (process.platform !== "win32") assertManagedCodexLauncherIgnoresAmbientNode();
  assertWindowsManagedCodexLauncherPinsNode();
  console.log("Installer transaction tests passed.");
}

function assertManagedCodexLauncherIgnoresAmbientNode() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-codex-launcher-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    const nodeRuntime = getNodeRuntimePaths(paths, "darwin", "arm64");
    const hostileBin = path.join(tempRoot, "hostile-bin");
    writeCodexVendor(paths.codexInstallRoot, "vendor");
    fs.mkdirSync(path.dirname(nodeRuntime.nodeBinary), { recursive: true });
    fs.mkdirSync(hostileBin, { recursive: true });
    fs.writeFileSync(
      nodeRuntime.nodeBinary,
      "#!/bin/sh\nprintf 'managed-node:%s\\n' \"$*\"\n",
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(hostileBin, "node"),
      "#!/bin/sh\nprintf 'ambient-node\\n'\n",
      { mode: 0o755 }
    );

    const launcher = writeManagedCodexLauncher({
      installRoot: paths.codexInstallRoot,
      nodeBinary: nodeRuntime.nodeBinary,
      platform: "darwin"
    });
    const hostilePath = [hostileBin, "/usr/bin", "/bin"].join(path.delimiter);
    const result = spawnSync(launcher, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: hostilePath }
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /^managed-node:/);
    assert(result.stdout.includes("codex.js --version"));
    assert(!result.stdout.includes("ambient-node"));

    fs.rmSync(nodeRuntime.nodeBinary, { force: true });
    const missingRuntime = spawnSync(launcher, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: hostilePath }
    });
    assert.strictEqual(missingRuntime.status, 127);
    assert.match(missingRuntime.stderr, /Managed Node\.js runtime is missing or not executable/);
    assert(!missingRuntime.stdout.includes("ambient-node"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertWindowsManagedCodexLauncherPinsNode() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-codex-launcher-win-"));
  try {
    const paths = getPaths(tempRoot, "win32");
    const nodeRuntime = getNodeRuntimePaths(paths, "win32", "x64");
    writeCodexVendor(paths.codexInstallRoot, "vendor", "win32");
    fs.mkdirSync(path.dirname(nodeRuntime.nodeBinary), { recursive: true });
    fs.writeFileSync(nodeRuntime.nodeBinary, "managed node");

    const launcher = writeManagedCodexLauncher({
      installRoot: paths.codexInstallRoot,
      nodeBinary: nodeRuntime.nodeBinary,
      platform: "win32"
    });
    const script = fs.readFileSync(launcher, "utf8");
    const relativeNode = path.relative(path.dirname(launcher), nodeRuntime.nodeBinary).replaceAll("/", "\\");
    assert(script.includes(`set "NODE_BIN=%SCRIPT_DIR%${relativeNode}"`));
    assert(script.includes('"%NODE_BIN%" "%SCRIPT_DIR%lib\\node_modules\\@openai\\codex\\bin\\codex.js" %*'));
    assert(!script.includes('\r\nnode "%SCRIPT_DIR%'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertMacLauncherStagesBeforeSwapAndRollsBack() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-launcher-swap-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    const managedApp = getManagedMacAppPath(paths);
    const launcherPath = path.join(tempRoot, "Applications", "TritonAI Harness.app");
    writeMacApp(managedApp, "managed-app");
    writeMacApp(launcherPath, "old-launcher");

    assert.strictEqual(
      writeMacAppLauncher(paths, () => {}, process.arch, { launcherPath }),
      launcherPath
    );
    const installedLauncher = fs.readFileSync(
      path.join(launcherPath, "Contents", "MacOS", "TritonAI Harness"),
      "utf8"
    );
    assert(installedLauncher.includes(`APP_PATH="${managedApp}"`));

    writeMacApp(launcherPath, "old-launcher");
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, ...args) => {
      if (String(target).includes(".tritonai-harness-launcher-stage-") && path.basename(String(target)) === "Info.plist") {
        throw new Error("simulated launcher staging failure");
      }
      return originalWriteFileSync(target, ...args);
    };
    try {
      assert.throws(
        () => writeMacAppLauncher(paths, () => {}, process.arch, { launcherPath }),
        /simulated launcher staging failure/
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.strictEqual(
      readMacAppVersion(launcherPath),
      "old-launcher",
      "failed launcher staging must not touch the Applications entry"
    );

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source.includes(".tritonai-harness-launcher-stage-") && target === launcherPath) {
        throw new Error("simulated launcher activation failure");
      }
      return originalRenameSync(source, target);
    };
    try {
      assert.throws(
        () => writeMacAppLauncher(paths, () => {}, process.arch, { launcherPath }),
        /simulated launcher activation failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.strictEqual(
      readMacAppVersion(launcherPath),
      "old-launcher",
      "failed launcher replacement must restore the Applications entry"
    );

    fs.renameSync = (source, target) => {
      if (source.includes(".tritonai-harness-launcher-stage-") && target === launcherPath) {
        throw new Error("simulated launcher activation failure");
      }
      if (source.includes(".tritonai-harness-launcher-backup-") && target === launcherPath) {
        throw new Error("simulated launcher rollback failure");
      }
      return originalRenameSync(source, target);
    };
    try {
      assert.throws(
        () => writeMacAppLauncher(paths, () => {}, process.arch, { launcherPath }),
        /Rollback also failed: simulated launcher rollback failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    const preservedLauncherBackup = fs.readdirSync(path.dirname(launcherPath))
      .find((entry) => entry.startsWith(".tritonai-harness-launcher-backup-"));
    assert(preservedLauncherBackup, "rollback failure must preserve the previous launcher for recovery");
    assert.strictEqual(
      readMacAppVersion(path.join(path.dirname(launcherPath), preservedLauncherBackup, path.basename(launcherPath))),
      "old-launcher"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertCodexVendorIdentityIsRequired() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-codex-identity-"));
  try {
    writeCodexVendor(tempRoot, "fixture");
    assert.strictEqual(isCodexVendorDir(tempRoot, "darwin", "arm64"), true);
    fs.writeFileSync(path.join(tempRoot, "manifest.json"), JSON.stringify({
      name: "@openai/codex",
      version: "0.0.0",
      target: "mac-arm64"
    }));
    assert.strictEqual(isCodexVendorDir(tempRoot, "darwin", "arm64"), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertMacReplacementStagesBeforeSwapAndRollsBack() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-swap-"));
  try {
    const managedApp = path.join(tempRoot, "managed", "TritonAI Harness.app");
    const sourceApp = path.join(tempRoot, "source", "TritonAI Harness.app");
    writeMacApp(managedApp, "old");
    writeMacApp(sourceApp, "new");
    let stopCalls = 0;
    await replaceMacAppTransactionally({
      sourceAppPath: sourceApp,
      managedAppPath: managedApp,
      emit: () => {},
      copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
      validateStagedApp: async () => {},
      stopRunningApp: async () => {
        stopCalls += 1;
        assert.strictEqual(readMacAppVersion(managedApp), "old", "the running app must stop before the swap");
      }
    });
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(readMacAppVersion(managedApp), "new");

    writeMacApp(sourceApp, "newer");
    await assert.rejects(
      replaceMacAppTransactionally({
        sourceAppPath: sourceApp,
        managedAppPath: managedApp,
        emit: () => {},
        copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
        validateStagedApp: async () => {},
        stopRunningApp: async () => { throw new Error("simulated stop timeout"); }
      }),
      /simulated stop timeout/
    );
    assert.strictEqual(readMacAppVersion(managedApp), "new", "a stop failure must abort before the swap");

    const stopRunningApp = async () => {};
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source.includes(".tritonai-harness-stage-") && target === managedApp) {
        throw new Error("simulated mac activation failure");
      }
      return originalRenameSync(source, target);
    };
    try {
      await assert.rejects(
        replaceMacAppTransactionally({
          sourceAppPath: sourceApp,
          managedAppPath: managedApp,
          emit: () => {},
          copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
          validateStagedApp: async () => {},
          stopRunningApp
        }),
        /simulated mac activation failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.strictEqual(readMacAppVersion(managedApp), "new", "failed replacement must restore the live app");

    fs.renameSync = (source, target) => {
      if (source.includes(".tritonai-harness-stage-") && target === managedApp) {
        throw new Error("simulated mac activation failure");
      }
      if (source.includes(".tritonai-harness-backup-") && target === managedApp) {
        throw new Error("simulated mac rollback failure");
      }
      return originalRenameSync(source, target);
    };
    try {
      await assert.rejects(
        replaceMacAppTransactionally({
          sourceAppPath: sourceApp,
          managedAppPath: managedApp,
          emit: () => {},
          copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
          validateStagedApp: async () => {},
          stopRunningApp
        }),
        /Rollback also failed: simulated mac rollback failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    const preservedMacBackup = fs.readdirSync(path.dirname(managedApp))
      .find((entry) => entry.startsWith(".tritonai-harness-backup-"));
    assert(preservedMacBackup, "rollback failure must preserve the previous app backup for recovery");
    assert.strictEqual(
      readMacAppVersion(path.join(path.dirname(managedApp), preservedMacBackup, path.basename(managedApp))),
      "new"
    );

    fs.rmSync(managedApp, { recursive: true, force: true });
    await replaceMacAppTransactionally({
      sourceAppPath: sourceApp,
      managedAppPath: managedApp,
      emit: () => {},
      copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
      validateStagedApp: async () => {},
      stopRunningApp: async () => assert.fail("a clean install must not stop an app")
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertCodexReplacementStagesBeforeSwapAndRollsBack() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-codex-swap-"));
  try {
    const source = path.join(tempRoot, "source");
    const target = path.join(tempRoot, "runtime", "codex");
    writeCodexVendor(source, "new");
    writeCodexVendor(target, "old");
    stageAndActivateBundledCodex({ source, target, platform: "darwin", arch: "arm64" });
    assert.strictEqual(readCodexVersion(target), "new");

    writeCodexVendor(source, "newer");
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (from.includes(".codex-install-stage-") && to === target) {
        throw new Error("simulated Codex activation failure");
      }
      return originalRenameSync(from, to);
    };
    try {
      assert.throws(
        () => stageAndActivateBundledCodex({ source, target, platform: "darwin", arch: "arm64" }),
        /simulated Codex activation failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.strictEqual(readCodexVersion(target), "new", "failed Codex replacement must restore the live CLI");

    fs.renameSync = (from, to) => {
      if (from.includes(".codex-install-stage-") && to === target) {
        throw new Error("simulated Codex activation failure");
      }
      if (from.includes(".codex-install-backup-") && to === target) {
        throw new Error("simulated Codex rollback failure");
      }
      return originalRenameSync(from, to);
    };
    try {
      assert.throws(
        () => stageAndActivateBundledCodex({ source, target, platform: "darwin", arch: "arm64" }),
        /Rollback also failed: simulated Codex rollback failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    const preservedCodexBackup = fs.readdirSync(path.dirname(target))
      .find((entry) => entry.startsWith(".codex-install-backup-"));
    assert(preservedCodexBackup, "rollback failure must preserve the previous Codex backup for recovery");
    assert.strictEqual(
      readCodexVersion(path.join(path.dirname(target), preservedCodexBackup, "previous")),
      "new"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function writeMacApp(appPath, version) {
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), "<plist/>");
  fs.writeFileSync(path.join(appPath, "Contents", "MacOS", "TritonAI Harness"), version, { mode: 0o755 });
}

function readMacAppVersion(appPath) {
  return fs.readFileSync(path.join(appPath, "Contents", "MacOS", "TritonAI Harness"), "utf8");
}

function writeCodexVendor(root, version, platform = "darwin") {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib", "node_modules", "@openai", "codex", "bin"), { recursive: true });
  const nativePackage = platform === "win32" ? "codex-win32-x64" : "codex-darwin-arm64";
  fs.mkdirSync(path.join(root, "lib", "node_modules", "@openai", "codex", "node_modules", "@openai", nativePackage), { recursive: true });
  if (platform === "win32") {
    fs.writeFileSync(path.join(root, "codex.cmd"), version);
  } else {
    fs.writeFileSync(path.join(root, "bin", "codex"), version, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(root, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    name: "@openai/codex",
    version: CODEX_CLI_VERSION,
    target: platform === "win32" ? "win-x64" : "mac-arm64"
  }));
}

function readCodexVersion(root) {
  return fs.readFileSync(path.join(root, "bin", "codex"), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
