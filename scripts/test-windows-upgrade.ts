const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getPaths } = require("../src/installer/paths");
const { getNodeRuntimePaths } = require("../src/installer/prerequisites");
const { CODEX_CLI_VERSION } = require("../src/installer/npm-policy");
const { runInstall } = require("../src/installer/runner");
const { writeInstallerVersionMarker } = require("../src/installer/installer-version-marker");
const { buildWindowsEnvironmentLines, powerShellLiteral } = require("../src/installer/profile");
const {
  cleanupStaleWindowsUpgradeBackup,
  installWindowsDesktop
} = require("../src/installer/t3code-desktop");

function simulateWindowsAcl(file, action, content) {
  if (action === "create") fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
}

async function main() {
  await assertExistingInstallIsUpgraded();
  await assertCompletedInstallRemovesStaleLongPathBackup();
  await assertIncompleteInstallPreservesUpgradeBackup();
  await assertInstallerFailureIsNotMasked();
  await assertNoOpWithOldExecutableIsRejected();
  await assertMatchingVersionNoOpIsRejected();
  await assertPackagedInstallerRequiresBundledHarness();
  await assertNoOpWithholdsNewInstallerMarker();
  await assertEnvironmentMigrationWaitsForSuccessfulInstall();
  await assertPackagedMissingCodexFailsClosed();
  assertPowerShellEnvironmentUsesLiteralQuoting();
  assertNsisProcessDetectionContract();
  console.log("Windows upgrade contract tests passed.");
}

async function assertCompletedInstallRemovesStaleLongPathBackup() {
  await withWindowsFixture(async (fixture) => {
    const installDir = path.dirname(fixture.existingApp);
    const backupDir = `${installDir}.old`;
    fs.writeFileSync(path.join(installDir, ".tritonai-install-complete"), "0.2.0");

    let residualDir = path.join(backupDir, "resources", "app.asar.unpacked", "node_modules");
    while (path.join(residualDir, "residual-source-file.cpp").length <= 270) {
      residualDir = path.join(residualDir, "react-native-long-path-segment");
    }
    fs.mkdirSync(residualDir, { recursive: true });
    const residualFile = path.join(residualDir, "residual-source-file.cpp");
    fs.writeFileSync(residualFile, "stale upgrade backup");
    assert(residualFile.length > 260, "fixture must exercise an over-260-character path");

    const events = [];
    let currentVersion = "0.2.0";
    let fingerprint = "old";
    await installWindowsDesktop({
      ...fixture.installOptions,
      emit: (message) => events.push(message),
      windowsInstallRuntime: {
        unblockWindowsFile: async () => {},
        runWindowsInstaller: async () => {
          assert.strictEqual(
            fs.existsSync(backupDir),
            false,
            "completed stale backup must be removed before launching NSIS"
          );
          currentVersion = "0.2.1";
          fingerprint = "new";
        },
        waitForWindowsT3CodeApp: async () => fixture.existingApp,
        readWindowsAppVersion: async () => currentVersion,
        readWindowsAppFingerprint: async () => fingerprint,
        finishWindowsInstall: async ({ appPath }) => ({ appPath, shortcutPath: `${appPath}.lnk` })
      }
    });

    assert.strictEqual(fs.existsSync(backupDir), false);
    assert(events.some((message) => message.includes("Removed completed TritonAI Harness upgrade backup.")));
  });
}

async function assertIncompleteInstallPreservesUpgradeBackup() {
  await withWindowsFixture(async (fixture) => {
    const installDir = path.dirname(fixture.existingApp);
    const backupDir = `${installDir}.old`;
    fs.mkdirSync(backupDir, { recursive: true });
    const recoveryFile = path.join(backupDir, "recovery.txt");
    fs.writeFileSync(recoveryFile, "previous complete install");

    assert.strictEqual(
      cleanupStaleWindowsUpgradeBackup({
        appPath: fixture.existingApp,
        emit: () => {},
        platform: "win32"
      }),
      false,
      "backup must be preserved when the current installation has no completion marker"
    );
    assert.strictEqual(fs.readFileSync(recoveryFile, "utf8"), "previous complete install");
  });
}

async function assertPackagedInstallerRequiresBundledHarness() {
  await withWindowsFixture(async (fixture) => {
    fs.rmSync(fixture.vendorDir, { recursive: true, force: true });
    await assert.rejects(
      installWindowsDesktop({
        ...fixture.installOptions,
        packaged: true,
        windowsInstallRuntime: noOpWindowsRuntime(fixture)
      }),
      /missing a valid bundled TritonAI Harness Windows installer/
    );
  });
}

async function assertPackagedMissingCodexFailsClosed() {
  await withWindowsFixture(async (fixture) => {
    const nodeRuntime = getNodeRuntimePaths(fixture.paths, "win32", "x64");
    fs.mkdirSync(nodeRuntime.nodeBinDir, { recursive: true });
    fs.writeFileSync(nodeRuntime.nodeBinary, "");
    fs.writeFileSync(nodeRuntime.npmBinary, "");
    fs.mkdirSync(path.dirname(nodeRuntime.npmCliJs), { recursive: true });
    fs.writeFileSync(nodeRuntime.npmCliJs, "");
    const commands = [];
    let desktopInstallCalled = false;

    await assert.rejects(
      runInstall({ apiKey: "test-key" }, {
        homeDir: fixture.homeDir,
        platform: "win32",
        arch: "x64",
        windowsAclRunner: simulateWindowsAcl,
        packaged: true,
        installerVersion: "0.2.1",
        appRoot: fixture.appRoot,
        resourcesPath: null,
        emit: () => {},
        ensurePrerequisites: async () => nodeRuntime,
        installBundledSkills: () => {},
        saveEnvironment: async () => {},
        checkTritonAiConnection: async () => ({ externalModelsEnabled: true }),
        installBundledCodexCli: async () => false,
        commandRunner: async (...args) => commands.push(args),
        installT3CodeDesktop: async () => {
          desktopInstallCalled = true;
          return {};
        }
      }),
      /npm fallback is disabled for packaged builds/
    );
    assert.strictEqual(commands.length, 0, "packaged builds must not fall back to npm when bundled Codex is missing");
    assert.strictEqual(desktopInstallCalled, false);
  });
}

async function assertExistingInstallIsUpgraded() {
  await withWindowsFixture(async (fixture) => {
    let currentVersion = "0.2.0";
    const installerRuns = [];
    const result = await installWindowsDesktop({
      ...fixture.installOptions,
      windowsInstallRuntime: {
        unblockWindowsFile: async () => {},
        runWindowsInstaller: async (installerPath, args) => {
          installerRuns.push({ installerPath, args });
          currentVersion = "0.2.1";
        },
        waitForWindowsT3CodeApp: async () => fixture.existingApp,
        readWindowsAppVersion: async () => currentVersion,
        readWindowsAppFingerprint: async () => currentVersion,
        finishWindowsInstall: async ({ appPath }) => ({ appPath, shortcutPath: `${appPath}.lnk` })
      }
    });

    assert.strictEqual(installerRuns.length, 1, "existing installs must still invoke the bundled NSIS installer");
    assert.deepStrictEqual(installerRuns[0].args, ["/S"]);
    assert.strictEqual(path.basename(installerRuns[0].installerPath), fixture.installerName);
    assert.notStrictEqual(path.dirname(installerRuns[0].installerPath), fixture.vendorDir, "bundled NSIS should run from the writable cache");
    assert.strictEqual(result.appPath, fixture.existingApp);
  });
}

async function assertMatchingVersionNoOpIsRejected() {
  await withWindowsFixture(async (fixture) => {
    await assert.rejects(
      installWindowsDesktop({
        ...fixture.installOptions,
        windowsInstallRuntime: {
          ...noOpWindowsRuntime(fixture),
          readWindowsAppVersion: async () => "0.2.1"
        }
      }),
      /did not replace or refresh the existing app executable/
    );
  });
}

async function assertInstallerFailureIsNotMasked() {
  await withWindowsFixture(async (fixture) => {
    await assert.rejects(
      installWindowsDesktop({
        ...fixture.installOptions,
        windowsInstallRuntime: {
          unblockWindowsFile: async () => {},
          runWindowsInstaller: async () => { throw new Error("simulated NSIS failure"); },
          waitForWindowsT3CodeApp: async () => fixture.existingApp,
          readWindowsAppVersion: async () => "0.2.0"
        }
      }),
      /simulated NSIS failure/
    );
  });
}

async function assertNoOpWithOldExecutableIsRejected() {
  await withWindowsFixture(async (fixture) => {
    await assert.rejects(
      installWindowsDesktop({
        ...fixture.installOptions,
        windowsInstallRuntime: noOpWindowsRuntime(fixture)
      }),
      /did not install the bundled version 0\.2\.1; found 0\.2\.0/
    );
  });
}

async function assertNoOpWithholdsNewInstallerMarker() {
  await withWindowsFixture(async (fixture) => {
    const paths = fixture.paths;
    writeInstallerVersionMarker({ paths, installerVersion: "0.2.0" });
    const nodeRuntime = getNodeRuntimePaths(paths, "win32", "x64");
    fs.mkdirSync(nodeRuntime.nodeBinDir, { recursive: true });
    fs.writeFileSync(nodeRuntime.nodeBinary, "");
    fs.writeFileSync(nodeRuntime.npmBinary, "");
    fs.mkdirSync(path.dirname(nodeRuntime.npmCliJs), { recursive: true });
    fs.writeFileSync(nodeRuntime.npmCliJs, "");
    let markerCalled = false;

    await assert.rejects(
      runInstall({ apiKey: "test-key" }, {
        homeDir: fixture.homeDir,
        platform: "win32",
        arch: "x64",
        windowsAclRunner: simulateWindowsAcl,
        installerVersion: "0.2.1",
        appRoot: fixture.appRoot,
        resourcesPath: null,
        emit: () => {},
        ensurePrerequisites: async () => nodeRuntime,
        installBundledSkills: () => {},
        saveEnvironment: async () => {},
        checkTritonAiConnection: async () => ({ externalModelsEnabled: true }),
        installBundledCodexCli: async () => true,
        getCodexVersion: () => CODEX_CLI_VERSION,
        writeManagedCodexLauncher: () => {},
        commandRunner: async () => {},
        installT3CodeDesktop: (options) => installWindowsDesktop({
          ...options,
          appRoot: fixture.appRoot,
          resourcesPath: null,
          windowsInstallRuntime: noOpWindowsRuntime(fixture)
        }),
        writeInstallerVersionMarker: (options) => {
          markerCalled = true;
          return writeInstallerVersionMarker(options);
        }
      }),
      /did not install the bundled version 0\.2\.1/
    );

    assert.strictEqual(markerCalled, false, "failed Harness updates must withhold the new Installer marker");
    assert.strictEqual(JSON.parse(fs.readFileSync(paths.installerVersionMarker, "utf8")).version, "0.2.0");
  });
}

async function assertEnvironmentMigrationWaitsForSuccessfulInstall() {
  await withWindowsFixture(async (fixture) => {
    const nodeRuntime = getNodeRuntimePaths(fixture.paths, "win32", "x64");
    fs.mkdirSync(nodeRuntime.nodeBinDir, { recursive: true });
    fs.writeFileSync(nodeRuntime.nodeBinary, "");
    fs.writeFileSync(nodeRuntime.npmBinary, "");
    fs.mkdirSync(path.dirname(nodeRuntime.npmCliJs), { recursive: true });
    fs.writeFileSync(nodeRuntime.npmCliJs, "");
    let cleanupCalls = 0;
    let cleanupError: Error | null = null;
    const diagnosticStatuses = [];
    const events = [];

    const runtime: any = {
      homeDir: fixture.homeDir,
      platform: "win32",
      arch: "x64",
      windowsAclRunner: simulateWindowsAcl,
      installerVersion: "0.2.5",
      appRoot: fixture.appRoot,
      resourcesPath: null,
      emit: (message) => events.push(message),
      ensurePrerequisites: async () => nodeRuntime,
      installBundledSkills: () => {},
      saveEnvironment: async () => ({
        finalize: async () => {
          cleanupCalls += 1;
          events.push("migration finalized");
          if (cleanupError) throw cleanupError;
        }
      }),
      checkTritonAiConnection: async () => ({ externalModelsEnabled: true }),
      installBundledCodexCli: async () => true,
      getCodexVersion: () => CODEX_CLI_VERSION,
      writeManagedCodexLauncher: () => {},
      commandRunner: async () => {},
      onDiagnostics: (diagnostics) => diagnosticStatuses.push(diagnostics.ok),
      writeInstallerVersionMarker: () => {},
      installT3CodeDesktop: async () => { throw new Error("simulated later install failure"); }
    };

    await assert.rejects(runInstall({ apiKey: "test-key" }, runtime), /simulated later install failure/);
    assert.strictEqual(cleanupCalls, 0, "later install failure must not remove recorded user environment state");
    assert.deepStrictEqual(diagnosticStatuses, [false]);

    runtime.installT3CodeDesktop = async () => ({});
    runtime.writeInstallerVersionMarker = () => { throw new Error("simulated marker failure"); };
    await assert.rejects(runInstall({ apiKey: "test-key" }, runtime), /simulated marker failure/);
    assert.strictEqual(cleanupCalls, 0, "marker failure must occur before legacy user environment cleanup");
    assert.deepStrictEqual(diagnosticStatuses, [false, false], "marker failure must not emit success diagnostics first");

    runtime.writeInstallerVersionMarker = () => {};
    cleanupError = new Error("simulated cleanup failure");
    await assert.rejects(runInstall({ apiKey: "test-key" }, runtime), /simulated cleanup failure/);
    assert.strictEqual(cleanupCalls, 1);
    assert.deepStrictEqual(diagnosticStatuses, [false, false, false], "cleanup failure must emit diagnostics exactly once");

    cleanupError = null;
    await runInstall({ apiKey: "test-key" }, runtime);
    assert.strictEqual(cleanupCalls, 2);
    assert.deepStrictEqual(diagnosticStatuses, [false, false, false, true]);
    assert(
      events.lastIndexOf("migration finalized") < events.lastIndexOf("Install flow finished."),
      "the install must not report completion before legacy environment cleanup finishes"
    );
  });
}

function assertPowerShellEnvironmentUsesLiteralQuoting() {
  const hostile = "C:\\Users\\O'Brien\\$cache`value\"quoted";
  assert.strictEqual(powerShellLiteral(hostile), "'C:\\Users\\O''Brien\\$cache`value\"quoted'");
  const lines = buildWindowsEnvironmentLines({
    apiKey: "key'$`\"value",
    pathEntries: [hostile],
    tritonAiEnvironment: { OPENAI_BASE_URL: "https://example.invalid/$v`1?'x=\"y\"" }
  });
  assert(lines.every((line) => !line.includes(' = "')), "generated assignments must not use interpolating double-quoted PowerShell literals");
  assert(lines.some((line) => line.includes("O''Brien")));
  assert(lines.some((line) => line.includes("key''$`\"value")));
  assert(lines.every((line) => !line.includes("CODEX_HOME")), "private launcher environment must not export CODEX_HOME");
  assert(lines[0].endsWith(" + $env:PATH"));
}

function assertNsisProcessDetectionContract() {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "build", "installer.nsh"), "utf8");
  const powerShellLine = source
    .split("\n")
    .find((line) => line.includes("Get-CimInstance -ClassName Win32_Process"));

  assert(source.includes("TRITONAI_NSIS_TARGET_EXECUTABLE"));
  assert(source.includes("$$_.ExecutablePath"));
  assert(source.includes("[System.StringComparison]::OrdinalIgnoreCase"));
  assert(source.includes("Stop-Process -Id $$proc.ProcessId -Force"));
  assert(source.includes("MB_RETRYCANCEL|MB_ICONEXCLAMATION"));
  assert.strictEqual(
    source.match(/Get-CimInstance -ClassName Win32_Process -ErrorAction Stop/g)?.length,
    2,
    "both NSIS process queries must fail closed"
  );
  assert(powerShellLine, "NSIS process detection command must exist");
  assert(!powerShellLine.includes("$INSTDIR"), "PowerShell must receive the target executable path out-of-band");
  assert(!source.includes("$$_.Path"), "Win32_Process.Path is not the executable path property");
}

function noOpWindowsRuntime(fixture) {
  return {
    unblockWindowsFile: async () => {},
    runWindowsInstaller: async () => {},
    waitForWindowsT3CodeApp: async () => fixture.existingApp,
    readWindowsAppVersion: async () => "0.2.0",
    readWindowsAppFingerprint: async () => "unchanged",
    finishWindowsInstall: async ({ appPath }) => ({ appPath, shortcutPath: `${appPath}.lnk` })
  };
}

async function withWindowsFixture(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-windows-upgrade-"));
  try {
    const appRoot = path.join(tempRoot, "app");
    const homeDir = path.join(tempRoot, "home");
    const paths = getPaths(homeDir, "win32");
    const vendorDir = path.join(appRoot, "vendor", "t3code-desktop", "win-x64");
    const installerName = "TritonAI-Harness-0.2.1-x64.exe";
    const installerBytes = Buffer.from("bundled Harness 0.2.1 NSIS fixture");
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, installerName), installerBytes);
    fs.writeFileSync(path.join(vendorDir, "latest.yml"), [
      "version: 0.2.1",
      "files:",
      `  - url: ${installerName}`,
      `    sha512: ${crypto.createHash("sha512").update(installerBytes).digest("base64")}`,
      `    size: ${installerBytes.length}`,
      ""
    ].join("\n"));
    const existingApp = path.join(homeDir, "AppData", "Local", "Programs", "TritonAI Harness", "TritonAI Harness.exe");
    fs.mkdirSync(path.dirname(existingApp), { recursive: true });
    fs.writeFileSync(existingApp, "old Harness 0.2.0");
    await callback({
      tempRoot,
      appRoot,
      homeDir,
      paths,
      vendorDir,
      installerName,
      existingApp,
      installOptions: { paths, arch: "x64", emit: () => {}, appRoot, resourcesPath: null, env: {} }
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
