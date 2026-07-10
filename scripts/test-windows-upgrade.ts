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
const { installWindowsDesktop } = require("../src/installer/t3code-desktop");

async function main() {
  await assertExistingInstallIsUpgraded();
  await assertInstallerFailureIsNotMasked();
  await assertNoOpWithOldExecutableIsRejected();
  await assertMatchingVersionNoOpIsRejected();
  await assertPackagedInstallerRequiresBundledHarness();
  await assertNoOpWithholdsNewInstallerMarker();
  await assertPackagedMissingCodexFailsClosed();
  assertPowerShellEnvironmentUsesLiteralQuoting();
  console.log("Windows upgrade contract tests passed.");
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
