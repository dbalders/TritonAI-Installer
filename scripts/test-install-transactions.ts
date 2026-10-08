const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { CODEX_CLI_VERSION } = require("../src/installer/npm-policy");
const { writeFileAtomic } = require("../src/installer/atomic-file");
const {
  recoverInterruptedDirectoryTransaction,
  writeDirectoryTransactionJournal
} = require("../src/installer/directory-transaction");
const {
  CODEX_BACKUP_PREFIX,
  CODEX_STAGE_PREFIX,
  CODEX_TRANSACTION_JOURNAL_FILE,
  isCodexVendorDir,
  recoverInterruptedCodexActivation,
  stageAndActivateBundledCodex,
  writeManagedCodexLauncher
} = require("../src/installer/codex-vendor");
const { getPaths } = require("../src/installer/paths");
const { getNodeRuntimePaths } = require("../src/installer/prerequisites");
const {
  getLegacyMacAppPath,
  installMacApp,
  replaceMacAppTransactionally
} = require("../src/installer/t3code-desktop");

async function main() {
  assertAtomicFileReplacementPreservesPriorStateOnFailure();
  assertInterruptedDirectoryReplacementRecoversDeterministically();
  assertInterruptedCodexActivationRestoresPreviousRuntime();
  await assertMacReplacementStagesBeforeSwapAndRollsBack();
  await assertMacAppReplacesLegacyLauncherInSharedApplications();
  await assertMacAppFallsBackForStandardAccounts();
  await assertMacAppFallsBackWhenSharedReplacementIsDenied();
  await assertMacAppNeverDowngradesATrustedNewerCopy();
  await assertMacAppSwapSurvivesUndeletableBackup();
  assertLegacyLauncherRemovalNeverHalfDeletes();
  assertRunningHarnessMatchingSparesNightly();
  assertFailedPointerKeepsThePreviousCopy();
  assertInterruptedPointerSwapIsRepaired();
  assertDoubleFailedPointerSwapIsRepairedNextRun();
  await assertSharedInstallRedirectsThePerUserCopy();
  if (process.platform === "darwin") {
    await assertMacAppCopyDropsQuarantine();
    await assertMacAppCopyClearsDirectQuarantine();
  }
  assertCodexVendorIdentityIsRequired();
  assertCodexReplacementStagesBeforeSwapAndRollsBack();
  assertFailedCodexRepairCanBeRetried();
  if (process.platform !== "win32") assertManagedCodexLauncherIgnoresAmbientNode();
  assertWindowsManagedCodexLauncherPinsNode();
  console.log("Installer transaction tests passed.");
}

function assertInterruptedCodexActivationRestoresPreviousRuntime() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-codex-recovery-"));
  const target = path.join(tempRoot, `openai-codex-${CODEX_CLI_VERSION}`);
  try {
    writeCodexVendor(target, "old-v1");
    const stageRoot = fs.mkdtempSync(path.join(tempRoot, CODEX_STAGE_PREFIX));
    const backupRoot = fs.mkdtempSync(path.join(tempRoot, CODEX_BACKUP_PREFIX));
    fs.renameSync(target, path.join(backupRoot, "previous"));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "partial"), "interrupted");
    const journalPath = path.join(tempRoot, CODEX_TRANSACTION_JOURNAL_FILE);
    writeDirectoryTransactionJournal({
      journalPath,
      kind: "managed Codex CLI",
      target,
      stageRoot,
      backupRoot,
      stagePrefix: CODEX_STAGE_PREFIX,
      backupPrefix: CODEX_BACKUP_PREFIX,
      stagedName: "next",
      backupName: "previous",
      hadPrevious: true
    });

    assert.deepStrictEqual(recoverInterruptedCodexActivation({
      target,
      platform: "darwin",
      arch: "arm64"
    }), { recovered: true, action: "rolled-back" });
    assert(isCodexVendorDir(target, "darwin", "arm64"));
    assert(!fs.existsSync(stageRoot));
    assert(!fs.existsSync(backupRoot));
    assert(!fs.existsSync(journalPath));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertInterruptedDirectoryReplacementRecoversDeterministically() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-directory-recovery-"));
  const target = path.join(tempRoot, "managed-payload");
  const journalPath = path.join(tempRoot, ".payload-transaction.json");
  const validate = (candidate) => fs.existsSync(path.join(candidate, "valid.marker"));
  try {
    const stageRoot = fs.mkdtempSync(path.join(tempRoot, ".payload-stage-"));
    const backupRoot = fs.mkdtempSync(path.join(tempRoot, ".payload-backup-"));
    fs.mkdirSync(path.join(backupRoot, "previous"), { recursive: true });
    fs.writeFileSync(path.join(backupRoot, "previous", "valid.marker"), "old");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "invalid.partial"), "partial");
    writeDirectoryTransactionJournal({
      journalPath,
      kind: "test payload",
      target,
      stageRoot,
      backupRoot,
      stagePrefix: ".payload-stage-",
      backupPrefix: ".payload-backup-",
      stagedName: "next",
      backupName: "previous",
      hadPrevious: true
    });
    assert.deepStrictEqual(recoverInterruptedDirectoryTransaction({
      journalPath,
      kind: "test payload",
      target,
      stagePrefix: ".payload-stage-",
      backupPrefix: ".payload-backup-",
      validate
    }), { recovered: true, action: "rolled-back" });
    assert.strictEqual(fs.readFileSync(path.join(target, "valid.marker"), "utf8"), "old");
    assert(!fs.existsSync(journalPath));

    const committedStage = fs.mkdtempSync(path.join(tempRoot, ".payload-stage-"));
    const committedBackup = fs.mkdtempSync(path.join(tempRoot, ".payload-backup-"));
    fs.mkdirSync(path.join(committedBackup, "previous"), { recursive: true });
    fs.writeFileSync(path.join(committedBackup, "previous", "valid.marker"), "old");
    fs.writeFileSync(path.join(target, "valid.marker"), "new");
    writeDirectoryTransactionJournal({
      journalPath,
      kind: "test payload",
      target,
      stageRoot: committedStage,
      backupRoot: committedBackup,
      stagePrefix: ".payload-stage-",
      backupPrefix: ".payload-backup-",
      stagedName: "next",
      backupName: "previous",
      hadPrevious: true
    });
    assert.deepStrictEqual(recoverInterruptedDirectoryTransaction({
      journalPath,
      kind: "test payload",
      target,
      stagePrefix: ".payload-stage-",
      backupPrefix: ".payload-backup-",
      validate
    }), { recovered: true, action: "committed" });
    assert.strictEqual(fs.readFileSync(path.join(target, "valid.marker"), "utf8"), "new");
    assert(!fs.existsSync(committedBackup));

    fs.writeFileSync(journalPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: "test payload",
      targetName: path.basename(target),
      stageRoot: "../outside",
      backupRoot: ".payload-backup-hostile",
      stagedName: "next",
      backupName: "previous",
      hadPrevious: true
    })}\n`);
    assert.throws(() => recoverInterruptedDirectoryTransaction({
      journalPath,
      kind: "test payload",
      target,
      stagePrefix: ".payload-stage-",
      backupPrefix: ".payload-backup-",
      validate
    }), /Unsafe transaction directory name/);
    assert(fs.existsSync(journalPath), "unsafe recovery evidence must remain for diagnosis");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertAtomicFileReplacementPreservesPriorStateOnFailure() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-atomic-file-"));
  const target = path.join(tempRoot, "environment");
  fs.writeFileSync(target, "previous\n", { mode: 0o640 });
  const originalRenameSync = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      if (destination === target) throw new Error("simulated atomic activation failure");
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => writeFileAtomic(target, "replacement\n", { preserveExistingMode: true }),
      /simulated atomic activation failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  try {
    assert.strictEqual(fs.readFileSync(target, "utf8"), "previous\n");
    assert.deepStrictEqual(fs.readdirSync(tempRoot), ["environment"]);
    writeFileAtomic(target, "replacement\n", { preserveExistingMode: true });
    assert.strictEqual(fs.readFileSync(target, "utf8"), "replacement\n");
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(target).mode & 0o777, 0o640);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

    const bundledCodexJs = path.join(paths.codexInstallRoot, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
    const npmCodexJs = path.join(paths.codexInstallRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(npmCodexJs), { recursive: true });
    fs.copyFileSync(bundledCodexJs, npmCodexJs);
    writeManagedCodexLauncher({
      installRoot: paths.codexInstallRoot,
      nodeBinary: nodeRuntime.nodeBinary,
      platform: "win32"
    });
    const npmScript = fs.readFileSync(launcher, "utf8");
    assert(npmScript.includes('"%NODE_BIN%" "%SCRIPT_DIR%node_modules\\@openai\\codex\\bin\\codex.js" %*'));
    assert(fs.existsSync(bundledCodexJs), "npm fallback should win even when an older bundled layout remains");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertMacAppReplacesLegacyLauncherInSharedApplications() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-app-placement-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    const systemApplicationsDir = path.join(tempRoot, "SystemApplications");
    const userApplicationsDir = path.join(paths.homeDir, "Applications");
    const sharedApp = path.join(systemApplicationsDir, "TritonAI Harness.app");
    const userLauncher = path.join(userApplicationsDir, "TritonAI Harness.app");
    const legacyApp = getLegacyMacAppPath(paths);
    const sourceApp = path.join(tempRoot, "mounted", "TritonAI Harness.app");
    writeMacApp(sourceApp, "signed-harness");
    writeMacApp(legacyApp, "legacy-managed-copy");
    writeLegacyMacLauncher(sharedApp);
    writeLegacyMacLauncher(userLauncher);
    const unrelatedApp = path.join(userApplicationsDir, "Other.app");
    writeMacApp(unrelatedApp, "other");
    fs.writeFileSync(path.join(systemApplicationsDir, ".tritonai-harness-launcher-transaction.json"), "{}");
    fs.mkdirSync(path.join(systemApplicationsDir, ".tritonai-harness-launcher-backup-abc123"));
    fs.mkdirSync(path.join(systemApplicationsDir, ".tritonai-harness-backup-orphan1"));
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const leftover of [".tritonai-harness-launcher-transaction.json", ".tritonai-harness-launcher-backup-abc123", ".tritonai-harness-backup-orphan1"]) {
      fs.utimesSync(path.join(systemApplicationsDir, leftover), longAgo, longAgo);
    }
    const otherAccountsStage = path.join(systemApplicationsDir, ".tritonai-harness-stage-live123");

    const events = [];
    const installedPath = await installMacApp({
      sourceAppPath: sourceApp,
      paths,
      emit: (message) => events.push(message),
      runtime: { systemApplicationsDir, replaceApp: replaceMacAppWithoutHostChecks }
    });

    assert.strictEqual(installedPath, sharedApp);
    assert.strictEqual(readMacAppVersion(sharedApp), "signed-harness", "the signed app must replace the shared launcher");
    assert(!fs.existsSync(userLauncher), "an old per-user launcher must not shadow the shared app");
    assertPointsAt(legacyApp, sharedApp, "Dock icons pinned to the old copy must keep opening the installed app");
    assert.strictEqual(readMacAppVersion(unrelatedApp), "other", "cleanup must only remove Installer-owned launchers");
    assert.deepStrictEqual(
      fs.readdirSync(systemApplicationsDir).sort(),
      ["TritonAI Harness.app"],
      "stale leftovers and write probes must be cleaned up"
    );

    // Another account's Installer staging right now must not be swept.
    fs.mkdirSync(otherAccountsStage);
    writeMacApp(sourceApp, "signed-harness");
    await installMacApp({
      sourceAppPath: sourceApp,
      paths,
      emit: () => {},
      runtime: { systemApplicationsDir, replaceApp: replaceMacAppWithoutHostChecks }
    });
    assert(fs.existsSync(otherAccountsStage), "a fresh staging directory may belong to a live install and must be left alone");
    fs.rmSync(otherAccountsStage, { recursive: true, force: true });
    assert(events.some((message) => message.includes("Removed old TritonAI Harness launcher")));

    writeMacApp(sourceApp, "signed-harness-rerun");
    assert.strictEqual(
      await installMacApp({
        sourceAppPath: sourceApp,
        paths,
        emit: () => {},
        runtime: { systemApplicationsDir, replaceApp: replaceMacAppWithoutHostChecks }
      }),
      sharedApp
    );
    assert.strictEqual(readMacAppVersion(sharedApp), "signed-harness-rerun", "rerunning the Installer must replace the app in place");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertMacAppFallsBackForStandardAccounts() {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-standard-user-"));
  const systemApplicationsDir = path.join(tempRoot, "SystemApplications");
  try {
    const paths = getPaths(tempRoot, "darwin");
    const sharedLauncher = path.join(systemApplicationsDir, "TritonAI Harness.app");
    const sourceApp = path.join(tempRoot, "mounted", "TritonAI Harness.app");
    const legacyApp = getLegacyMacAppPath(paths);
    writeMacApp(sourceApp, "signed-harness");
    writeMacApp(legacyApp, "legacy-managed-copy");
    writeLegacyMacLauncher(sharedLauncher);
    fs.chmodSync(systemApplicationsDir, 0o555);

    const events = [];
    const installedPath = await installMacApp({
      sourceAppPath: sourceApp,
      paths,
      emit: (message) => events.push(message),
      runtime: { systemApplicationsDir, replaceApp: replaceMacAppWithoutHostChecks }
    });

    const userApp = path.join(paths.homeDir, "Applications", "TritonAI Harness.app");
    assert.strictEqual(installedPath, userApp);
    assert.strictEqual(readMacAppVersion(userApp), "signed-harness");
    assert.deepStrictEqual(fs.readdirSync(systemApplicationsDir), ["TritonAI Harness.app"], "an unwritable shared folder must be left untouched");
    assert(isLegacyLauncher(sharedLauncher), "the shared launcher must not be half-deleted");
    assert.strictEqual(
      readMacAppVersion(legacyApp),
      "signed-harness",
      "the launcher this account can't remove must open the newly installed app"
    );
    assertPointsAt(legacyApp, userApp, "the surviving launcher reaches the new app through the pointer");
    assert(events.some((message) => message.includes("can't be removed by this account")));
  } finally {
    fs.chmodSync(systemApplicationsDir, 0o755);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertMacAppFallsBackWhenSharedReplacementIsDenied() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-denied-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    const systemApplicationsDir = path.join(tempRoot, "SystemApplications");
    const sharedApp = path.join(systemApplicationsDir, "TritonAI Harness.app");
    const sourceApp = path.join(tempRoot, "mounted", "TritonAI Harness.app");
    writeMacApp(sourceApp, "signed-harness");
    writeMacApp(sharedApp, "other-admins-app");
    const attempts = [];
    const deniedThenReal = async (options) => {
      attempts.push(options.managedAppPath);
      if (options.managedAppPath === sharedApp) {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      }
      return replaceMacAppWithoutHostChecks(options);
    };

    const installedPath = await installMacApp({
      sourceAppPath: sourceApp,
      paths,
      emit: () => {},
      runtime: { systemApplicationsDir, replaceApp: deniedThenReal }
    });
    const userApp = path.join(paths.homeDir, "Applications", "TritonAI Harness.app");
    assert.deepStrictEqual(attempts, [sharedApp, userApp]);
    assert.strictEqual(installedPath, userApp);
    assert.strictEqual(readMacAppVersion(sharedApp), "other-admins-app");

    await assert.rejects(
      installMacApp({
        sourceAppPath: sourceApp,
        paths,
        emit: () => {},
        runtime: {
          systemApplicationsDir,
          replaceApp: async () => {
            throw Object.assign(new Error("EACCES: permission denied. Rollback also failed"), { code: "EACCES", rollbackFailed: true });
          }
        }
      }),
      /Rollback also failed/,
      "a failed rollback must surface instead of silently installing a second copy"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertMacAppNeverDowngradesATrustedNewerCopy() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-versions-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    const systemApplicationsDir = path.join(tempRoot, "SystemApplications");
    const sharedApp = path.join(systemApplicationsDir, "TritonAI Harness.app");
    const legacyApp = getLegacyMacAppPath(paths);
    const sourceApp = path.join(tempRoot, "mounted", "TritonAI Harness.app");
    const versions = new Map();
    const untrusted = new Set();
    let stops = 0;
    let stoppedPaths = [];
    let newerKept = null;
    const runtime = {
      systemApplicationsDir,
      replaceApp: (options) => replaceMacAppWithoutHostChecks({
        ...options,
        stopRunningApp: async ({ appPaths }) => {
          stops += 1;
          stoppedPaths = appPaths;
        }
      }),
      onPlaced: (placement) => { newerKept = placement.installedNewerThanBundle; },
      readAppVersion: async (appPath) => versions.get(readMacAppVersion(appPath)) || null,
      verifyInstalledApp: async (appPath) => {
        if (untrusted.has(readMacAppVersion(appPath))) throw new Error("signature mismatch");
      }
    };
    const install = () => installMacApp({ sourceAppPath: sourceApp, paths, emit: () => {}, runtime });

    writeMacApp(sourceApp, "bundled");
    versions.set("bundled", "0.3.6");
    writeMacApp(sharedApp, "self-updated");
    versions.set("self-updated", "0.3.7");
    await install();
    assert.strictEqual(readMacAppVersion(sharedApp), "self-updated", "a newer trusted app must not be replaced by an older bundle");
    assert.strictEqual(stops, 1, "keeping the newer app must still stop it before cleanup and the defaults patcher run");
    assert.strictEqual(newerKept, true, "keeping a newer app than the bundle must skip the frozen defaults patcher");
    assert(stoppedPaths.includes(path.resolve(sharedApp)) && stoppedPaths.includes(path.resolve(legacyApp)));
    assert(
      !stoppedPaths.some((entry) => entry.includes("Nightly")),
      "only stable install paths are quit; Nightly shares the bundle id"
    );

    untrusted.add("self-updated");
    await install();
    assert.strictEqual(readMacAppVersion(sharedApp), "bundled", "an app that fails verification must be replaced");

    writeMacApp(legacyApp, "legacy-updated");
    versions.set("legacy-updated", "0.3.8");
    await install();
    assert.strictEqual(readMacAppVersion(sharedApp), "legacy-updated", "a newer self-updated legacy copy must be moved instead of downgraded");
    assertPointsAt(legacyApp, sharedApp, "the moved legacy copy leaves a pointer behind");

    writeMacApp(legacyApp, "legacy-prerelease");
    versions.set("legacy-prerelease", "0.3.8-beta.1");
    versions.set("bundled", "0.3.8");
    writeMacApp(sharedApp, "bundled");
    await install();
    assert.strictEqual(readMacAppVersion(sharedApp), "bundled", "a prerelease of the same version is older than the release");

    // A previous run interrupted mid-swap left the newer app in its backup; it must win, not be overwritten.
    writeMacApp(sharedApp, "interrupted-newer");
    versions.set("interrupted-newer", "0.3.9");
    versions.set("bundled", "0.3.6");
    const stageRoot = fs.mkdtempSync(path.join(systemApplicationsDir, ".tritonai-harness-stage-"));
    const backupRoot = fs.mkdtempSync(path.join(systemApplicationsDir, ".tritonai-harness-backup-"));
    fs.renameSync(sharedApp, path.join(backupRoot, "TritonAI Harness.app"));
    writeDirectoryTransactionJournal({
      journalPath: path.join(systemApplicationsDir, ".tritonai-harness-app-transaction.json"),
      kind: "managed TritonAI Harness app",
      target: sharedApp,
      stageRoot,
      backupRoot,
      stagePrefix: ".tritonai-harness-stage-",
      backupPrefix: ".tritonai-harness-backup-",
      stagedName: "TritonAI Harness.app",
      backupName: "TritonAI Harness.app",
      hadPrevious: true
    });
    await install();
    assert.strictEqual(readMacAppVersion(sharedApp), "interrupted-newer", "recovery must run before choosing the newest app");

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      writeMacApp(sharedApp, "shared-newest");
      versions.set("shared-newest", "0.4.0");
      fs.chmodSync(systemApplicationsDir, 0o555);
      try {
        const userApp = await install();
        assert.strictEqual(userApp, path.join(paths.homeDir, "Applications", "TritonAI Harness.app"));
        assert.strictEqual(readMacAppVersion(userApp), "shared-newest", "a per-user install must copy a newer shared app, not downgrade to the bundle");
      } finally {
        fs.chmodSync(systemApplicationsDir, 0o755);
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertMacAppSwapSurvivesUndeletableBackup() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-backup-cleanup-"));
  const originalRmSync = fs.rmSync;
  try {
    const target = path.join(tempRoot, "Applications", "TritonAI Harness.app");
    const sourceApp = path.join(tempRoot, "mounted", "TritonAI Harness.app");
    writeMacApp(target, "other-admins-app");
    writeMacApp(sourceApp, "signed-harness");
    fs.rmSync = (candidate, ...args) => {
      if (path.basename(String(candidate)).startsWith(".tritonai-harness-backup-")) {
        throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
      }
      return originalRmSync(candidate, ...args);
    };
    const events = [];
    await replaceMacAppWithoutHostChecks({ sourceAppPath: sourceApp, managedAppPath: target, emit: (message) => events.push(message) });
    fs.rmSync = originalRmSync;
    assert.strictEqual(readMacAppVersion(target), "signed-harness");
    assert(!fs.existsSync(path.join(path.dirname(target), ".tritonai-harness-app-transaction.json")), "a completed swap must not leave a journal that fails the next run");
    assert(events.some((message) => message.includes("Could not remove leftover")));
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function isLegacyLauncher(appPath) {
  try {
    return fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8").includes("edu.ucsd.ai.tritonai-harness-launcher");
  } catch {
    return false;
  }
}

function assertLegacyLauncherRemovalNeverHalfDeletes() {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-launcher-removal-"));
  const protectedDir = path.join(tempRoot, "SystemApplications", "TritonAI Harness.app", "Contents", "Resources");
  let tombstoneResources = null;
  try {
    const paths = getPaths(tempRoot, "darwin");
    const systemApplicationsDir = path.join(tempRoot, "SystemApplications");
    const userApp = path.join(paths.homeDir, "Applications", "TritonAI Harness.app");
    const launcher = path.join(systemApplicationsDir, "TritonAI Harness.app");
    writeMacApp(userApp, "per-user-app");
    writeLegacyMacLauncher(launcher);
    fs.mkdirSync(protectedDir, { recursive: true });
    fs.writeFileSync(path.join(protectedDir, "icon.icns"), "icon");
    fs.chmodSync(protectedDir, 0o555);
    const events = [];
    removeLegacyMacInstallForTest({ paths, appPath: userApp, systemApplicationsDir, events });
    assert(!fs.existsSync(launcher), "a launcher that can be moved must leave its public location in one step");
    const tombstone = fs.readdirSync(systemApplicationsDir).find((entry) => entry.startsWith(".tritonai-harness-removed-"));
    assert(tombstone, "an undeletable launcher body must stay hidden under a removal name");
    tombstoneResources = path.join(systemApplicationsDir, tombstone, "Contents", "Resources");
    assert(events.some((message) => message.includes("could not finish deleting")));
  } finally {
    for (const dir of [protectedDir, tombstoneResources]) {
      if (dir && fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function removeLegacyMacInstallForTest({ paths, appPath, systemApplicationsDir, events }) {
  const { removeLegacyMacInstall } = require("../src/installer/t3code-desktop");
  removeLegacyMacInstall({
    paths,
    appPath,
    applicationsDirs: [systemApplicationsDir, path.join(paths.homeDir, "Applications")],
    emit: (message) => events.push(message)
  });
}

function assertRunningHarnessMatchingSparesNightly() {
  const { shouldQuitRunningMacHarness } = require("../src/installer/t3code-desktop");
  const targets = ["/Applications/TritonAI Harness.app", "/Users/a/.agents/ucsd/apps/TritonAI Harness.app"];
  assert.strictEqual(shouldQuitRunningMacHarness("/Applications/TritonAI Harness.app", targets), true);
  assert.strictEqual(shouldQuitRunningMacHarness("/Users/a/.agents/ucsd/apps/TritonAI Harness.app", targets), true);
  assert.strictEqual(
    shouldQuitRunningMacHarness("/private/var/folders/x/T/AppTranslocation/ABC/d/TritonAI Harness.app", targets),
    true,
    "a translocated quarantined copy must be quit before its replacement"
  );
  assert.strictEqual(shouldQuitRunningMacHarness("/Applications/TritonAI Harness (Nightly).app", targets), false);
  assert.strictEqual(
    shouldQuitRunningMacHarness("/private/var/folders/x/T/AppTranslocation/ABC/d/TritonAI Harness (Nightly).app", targets),
    false,
    "Nightly shares the bundle id but must never be quit"
  );
  assert.strictEqual(shouldQuitRunningMacHarness("/Users/a/Downloads/TritonAI Harness.app", targets), false);
}

function assertFailedPointerKeepsThePreviousCopy() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-pointer-"));
  const originalSymlinkSync = fs.symlinkSync;
  try {
    const paths = getPaths(tempRoot, "darwin");
    const legacyApp = getLegacyMacAppPath(paths);
    const sharedApp = path.join(tempRoot, "SystemApplications", "TritonAI Harness.app");
    writeMacApp(legacyApp, "previous-copy");
    writeMacApp(sharedApp, "installed");
    fs.symlinkSync = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, symlink"), { code: "ENOSPC" });
    };
    const events = [];
    removeLegacyMacInstallForTest({ paths, appPath: sharedApp, systemApplicationsDir: path.dirname(sharedApp), events });
    fs.symlinkSync = originalSymlinkSync;
    assert.strictEqual(
      readMacAppVersion(legacyApp),
      "previous-copy",
      "if the pointer can't be created, the old copy that shortcuts open must stay in place"
    );
    assert(events.some((message) => message.includes("could not stage a pointer")));
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(legacyApp)).filter((entry) => entry.startsWith(".")),
      [],
      "no staged pointer or retired copy may be left behind"
    );
  } finally {
    fs.symlinkSync = originalSymlinkSync;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertInterruptedPointerSwapIsRepaired() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-pointer-resume-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    const legacyApp = getLegacyMacAppPath(paths);
    const legacyDir = path.dirname(legacyApp);
    const sharedApp = path.join(tempRoot, "SystemApplications", "TritonAI Harness.app");
    writeMacApp(sharedApp, "installed");
    // Interrupted after the previous copy was moved aside, before the link was swapped in.
    writeMacApp(path.join(legacyDir, ".tritonai-harness-removed-abc123"), "previous-copy");
    fs.symlinkSync(sharedApp, path.join(legacyDir, ".tritonai-harness-pointer-abc123"));
    removeLegacyMacInstallForTest({ paths, appPath: sharedApp, systemApplicationsDir: path.dirname(sharedApp), events: [] });
    assertPointsAt(legacyApp, sharedApp, "a rerun must finish an interrupted pointer swap");

    // An old launcher this account can't remove still opens the legacy path even if it never existed.
    // A read-only folder only blocks removal for a non-root POSIX user.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    fs.rmSync(legacyDir, { recursive: true, force: true });
    const systemApplicationsDir = path.join(tempRoot, "LockedApplications");
    writeLegacyMacLauncher(path.join(systemApplicationsDir, "TritonAI Harness.app"));
    fs.chmodSync(systemApplicationsDir, 0o555);
    try {
      removeLegacyMacInstallForTest({ paths, appPath: sharedApp, systemApplicationsDir, events: [] });
    } finally {
      fs.chmodSync(systemApplicationsDir, 0o755);
    }
    assertPointsAt(legacyApp, sharedApp, "a surviving launcher must reach the installed app");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertSharedInstallRedirectsThePerUserCopy() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-user-to-shared-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    const systemApplicationsDir = path.join(tempRoot, "SystemApplications");
    const sharedApp = path.join(systemApplicationsDir, "TritonAI Harness.app");
    const userApp = path.join(paths.homeDir, "Applications", "TritonAI Harness.app");
    const sourceApp = path.join(tempRoot, "mounted", "TritonAI Harness.app");
    writeMacApp(sourceApp, "bundled");
    writeStableMacHarness(userApp, "earlier-standard-account-copy");
    fs.mkdirSync(systemApplicationsDir, { recursive: true });
    await installMacApp({
      sourceAppPath: sourceApp,
      paths,
      emit: () => {},
      runtime: { systemApplicationsDir, replaceApp: replaceMacAppWithoutHostChecks, readAppVersion: async () => null }
    });
    assert.strictEqual(readMacAppVersion(sharedApp), "bundled");
    assertPointsAt(userApp, sharedApp, "Dock icons for the earlier per-user copy must open the shared install");

    // Interrupted mid-swap: the per-user copy was moved aside before its link was published.
    fs.rmSync(userApp, { force: true });
    const userAppsDir = path.dirname(userApp);
    writeStableMacHarness(path.join(userAppsDir, ".tritonai-harness-removed-def456"), "earlier-standard-account-copy");
    fs.symlinkSync(sharedApp, path.join(userAppsDir, ".tritonai-harness-pointer-def456"));
    await installMacApp({
      sourceAppPath: sourceApp,
      paths,
      emit: () => {},
      runtime: { systemApplicationsDir, replaceApp: replaceMacAppWithoutHostChecks, readAppVersion: async () => null }
    });
    assertPointsAt(userApp, sharedApp, "a rerun must finish an interrupted per-user pointer swap");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function writeStableMacHarness(appPath, version) {
  writeMacApp(appPath, version);
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>CFBundleIdentifier</key>",
    "  <string>edu.ucsd.tritonai.harness</string>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n"));
}

function assertDoubleFailedPointerSwapIsRepairedNextRun() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-pointer-double-"));
  const originalRenameSync = fs.renameSync;
  try {
    const paths = getPaths(tempRoot, "darwin");
    const legacyApp = getLegacyMacAppPath(paths);
    const sharedApp = path.join(tempRoot, "SystemApplications", "TritonAI Harness.app");
    writeMacApp(legacyApp, "previous-copy");
    writeMacApp(sharedApp, "installed");
    // Publishing the link and restoring the retired copy both fail.
    fs.renameSync = (source, target) => {
      if (String(target) === legacyApp) throw Object.assign(new Error("EIO: simulated failure"), { code: "EIO" });
      return originalRenameSync(source, target);
    };
    const events = [];
    removeLegacyMacInstallForTest({ paths, appPath: sharedApp, systemApplicationsDir: path.dirname(sharedApp), events });
    fs.renameSync = originalRenameSync;
    assert(events.some((message) => message.includes("the next run will finish it")));
    assert(
      fs.readdirSync(path.dirname(legacyApp)).some((entry) => entry.startsWith(".tritonai-harness-pointer-")),
      "the staged link must survive as the recovery marker"
    );
    removeLegacyMacInstallForTest({ paths, appPath: sharedApp, systemApplicationsDir: path.dirname(sharedApp), events: [] });
    assertPointsAt(legacyApp, sharedApp, "the next run must publish the pointer");
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertPointsAt(link, target, message) {
  assert(fs.lstatSync(link).isSymbolicLink(), `${message}: ${link} must be a symlink`);
  assert.strictEqual(path.resolve(path.dirname(link), fs.readlinkSync(link)), path.resolve(target), message);
}

function replaceMacAppWithoutHostChecks(options) {
  return replaceMacAppTransactionally({
    ...options,
    copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
    validateStagedApp: async () => {},
    stopRunningApp: options.stopRunningApp || (async () => {})
  });
}

function writeLegacyMacLauncher(appPath) {
  writeMacApp(appPath, "#!/usr/bin/env sh\nexec legacy\n");
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>CFBundleIdentifier</key>",
    "  <string>edu.ucsd.ai.tritonai-harness-launcher</string>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n"));
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

    const recoveryEvents = [];
    await replaceMacAppTransactionally({
      sourceAppPath: sourceApp,
      managedAppPath: managedApp,
      emit: (message) => recoveryEvents.push(message),
      copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
      validateStagedApp: async () => {},
      stopRunningApp
    });
    assert.strictEqual(readMacAppVersion(managedApp), "newer");
    assert(recoveryEvents.some((message) => message.includes("Restored the previous managed TritonAI Harness app")));

    const cleanManagedApp = path.join(tempRoot, "clean-managed", "TritonAI Harness.app");
    let cleanInstallStopCalls = 0;
    await replaceMacAppTransactionally({
      sourceAppPath: sourceApp,
      managedAppPath: cleanManagedApp,
      emit: () => {},
      copyApp: async (source, target) => fs.cpSync(source, target, { recursive: true }),
      validateStagedApp: async () => {},
      stopRunningApp: async () => {
        cleanInstallStopCalls += 1;
        assert.strictEqual(
          fs.existsSync(cleanManagedApp),
          false,
          "the same-bundle stop must also cover migrations without an existing managed app"
        );
      }
    });
    assert.strictEqual(cleanInstallStopCalls, 1, "activation must always stop a running same-bundle Harness app");
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

function assertFailedCodexRepairCanBeRetried() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-codex-repair-"));
  const source = path.join(root, "source");
  const target = path.join(root, "runtime", "codex");
  const rename = fs.renameSync;
  try {
    writeCodexVendor(source, "replacement");
    writeCodexVendor(target, "damaged");
    fs.writeFileSync(path.join(target, "manifest.json"), "invalid JSON");
    fs.renameSync = (from, to) => {
      if (from.includes(CODEX_STAGE_PREFIX) && to === target) throw new Error("transient activation failure");
      return rename(from, to);
    };
    assert.throws(() => stageAndActivateBundledCodex({ source, target, platform: "darwin", arch: "arm64" }), /transient activation/);
    fs.renameSync = rename;
    assert.equal(readCodexVersion(target), "damaged", "the previous payload must be preserved");
    assert(!fs.existsSync(path.join(path.dirname(target), CODEX_TRANSACTION_JOURNAL_FILE)), "completed rollback must clear its journal");
    stageAndActivateBundledCodex({ source, target, platform: "darwin", arch: "arm64" });
    assert.equal(readCodexVersion(target), "replacement", "a transient failure must not permanently block repair");
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, { recursive: true, force: true });
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
  const nativeBin = path.join(root, "lib", "node_modules", "@openai", "codex", "node_modules", "@openai", nativePackage, "vendor",
    platform === "win32" ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin", "bin");
  fs.mkdirSync(nativeBin, { recursive: true });
  fs.writeFileSync(path.join(nativeBin, platform === "win32" ? "codex.exe" : "codex"), "native fixture", { mode: 0o755 });
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

// Mirrors a browser-downloaded Installer: its bundled image carries the quarantine flag, so macOS
// mounts it quarantined and a plain copy of the app inherits com.apple.quarantine.
async function assertMacAppCopyDropsQuarantine() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-quarantine-"));
  const mountPoint = path.join(tempRoot, "mount");
  let mounted = false;
  try {
    const imageSource = path.join(tempRoot, "image");
    const image = path.join(tempRoot, "harness.dmg");
    const target = path.join(tempRoot, "apps", "TritonAI Harness.app");
    writeMacApp(path.join(imageSource, "TritonAI Harness.app"), "signed-harness");
    runChecked("hdiutil", ["create", "-quiet", "-srcfolder", imageSource, "-fs", "HFS+", "-format", "UDZO", image]);
    runChecked("xattr", ["-w", "com.apple.quarantine", "0083;00000000;Safari;", image]);
    fs.mkdirSync(mountPoint);
    runChecked("hdiutil", ["attach", "-quiet", image, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    mounted = true;
    // Control: prove this mount still makes a plain copy quarantined, or the check below proves nothing.
    const control = path.join(tempRoot, "control", "TritonAI Harness.app");
    fs.mkdirSync(path.dirname(control), { recursive: true });
    runChecked("ditto", [path.join(mountPoint, "TritonAI Harness.app"), control]);
    assert.notStrictEqual(runChecked("find", [control, "-xattrname", "com.apple.quarantine"]).trim(), "",
      "a plain copy from the quarantined test mount must carry quarantine");

    await replaceMacAppTransactionally({
      sourceAppPath: path.join(mountPoint, "TritonAI Harness.app"),
      managedAppPath: target,
      emit: () => {},
      validateStagedApp: async () => {},
      stopRunningApp: async () => {}
    });
    assert.strictEqual(runChecked("find", [target, "-xattrname", "com.apple.quarantine"]).trim(), "",
      "the installed app must not inherit the image's quarantine flag");
  } finally {
    if (mounted) spawnSync("hdiutil", ["detach", "-quiet", "-force", mountPoint], { timeout: NATIVE_COMMAND_TIMEOUT_MS });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

// An earlier Installer's plain ditto from a quarantined mount left the attribute directly on every
// file of the existing copy, which --noqtn alone does not remove.
async function assertMacAppCopyClearsDirectQuarantine() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-mac-direct-quarantine-"));
  try {
    const sourceApp = path.join(tempRoot, "source", "TritonAI Harness.app");
    const target = path.join(tempRoot, "apps", "TritonAI Harness.app");
    writeMacApp(sourceApp, "signed-harness");
    for (const flagged of [sourceApp, path.join(sourceApp, "Contents", "MacOS", "TritonAI Harness")]) {
      runChecked("xattr", ["-w", "com.apple.quarantine", "0083;00000000;Safari;", flagged]);
    }
    await replaceMacAppTransactionally({
      sourceAppPath: sourceApp,
      managedAppPath: target,
      emit: () => {},
      validateStagedApp: async () => {},
      stopRunningApp: async () => {}
    });
    assert.strictEqual(runChecked("find", [target, "-xattrname", "com.apple.quarantine"]).trim(), "");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const NATIVE_COMMAND_TIMEOUT_MS = 60 * 1000;

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: NATIVE_COMMAND_TIMEOUT_MS });
  assert(!result.error, `${command} ${args.join(" ")} failed or timed out: ${result.error && result.error.message}`);
  assert.strictEqual(result.status, 0, `${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
