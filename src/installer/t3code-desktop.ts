const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { defaultAppRoot } = require("./app-root");
const { getNodeRuntimePaths } = require("./prerequisites");
const { spawn } = require("child_process");

const RELEASE_BASE = "https://github.com/dbalders/TritonAI-Harness/releases/latest/download";
const MAC_RELEASE_BASE = RELEASE_BASE;
const WIN_RELEASE_BASE = RELEASE_BASE;
const TRITONAI_APP_DISPLAY_NAME = "TritonAI Harness";
const MAC_MANAGED_APP_NAME = `${TRITONAI_APP_DISPLAY_NAME}.app`;
const MAC_TRITONAI_APP_PATH = `/Applications/${MAC_MANAGED_APP_NAME}`;
const MAC_MANIFEST_FILE = "latest-mac.yml";
const WIN_MANIFEST_FILE = "latest.yml";
const TRITONAI_LAUNCHER_NAME = TRITONAI_APP_DISPLAY_NAME;
const MAC_LAUNCHER_EXECUTABLE_NAME = TRITONAI_APP_DISPLAY_NAME;
const MAC_LAUNCHER_ICON_FILE = "icon.icns";
const MAC_SOURCE_APP_NAMES = [
  MAC_MANAGED_APP_NAME
];
const WIN_EXE_NAMES = [
  "TritonAI Harness.exe"
];
const WIN_INSTALL_DIR_NAMES = [
  "TritonAI Harness"
];

interface DesktopBundleOptions {
  arch?: NodeJS.Architecture;
  resourcesPath?: string;
  appRoot?: string;
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  allowFailure?: boolean;
}

interface WindowsInstallRuntime {
  unblockWindowsFile?: typeof unblockWindowsFile;
  runWindowsInstaller?: typeof runWindowsInstaller;
  waitForWindowsT3CodeApp?: typeof waitForWindowsT3CodeApp;
  readWindowsAppVersion?: typeof readWindowsAppVersion;
  readWindowsAppFingerprint?: typeof readWindowsAppFingerprint;
  finishWindowsInstall?: typeof finishWindowsInstall;
}

async function installT3CodeDesktop({ paths, platform, arch, emit, env, resourcesPath, appRoot, packaged, windowsInstallRuntime }) {
  if (platform === "darwin") {
    return installMacDesktop({ paths, arch, emit, resourcesPath, appRoot, packaged });
  }

  if (platform === "win32") {
    return installWindowsDesktop({
      paths,
      arch,
      emit,
      env,
      resourcesPath,
      appRoot,
      packaged,
      windowsInstallRuntime
    });
  }

  emit(`${TRITONAI_APP_DISPLAY_NAME} desktop install is not automated on ${platform}; skipping desktop app.`);
  return { skipped: true };
}

async function installMacDesktop({ paths, arch, emit, resourcesPath, appRoot, packaged }) {
  const bundledDmg = getBundledMacDmg({ arch, resourcesPath, appRoot });
  const downloadDir = path.join(paths.cacheDir, "t3code-desktop");
  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-desktop-"));
  const managedAppPath = getManagedMacAppPath(paths);
  fs.mkdirSync(downloadDir, { recursive: true });

  let dmgPath;
  if (bundledDmg) {
    dmgPath = bundledDmg.dmgPath;
    verifyDownload(dmgPath, bundledDmg.expected);
    emit(`Installing ${TRITONAI_APP_DISPLAY_NAME} from bundled image at ${dmgPath}`);
    emit(`Using signed app-bundled ${TRITONAI_APP_DISPLAY_NAME} image; validating with hdiutil before install.`);
  } else if (packaged) {
    throw new Error(`This packaged TritonAI Installer is missing a valid bundled ${TRITONAI_APP_DISPLAY_NAME} macOS image.`);
  } else {
    const manifestText = await downloadText(`${MAC_RELEASE_BASE}/${MAC_MANIFEST_FILE}`);
    const manifest = parseLatestYml(manifestText);
    const selected = selectMacDmg(manifest, arch);
    dmgPath = path.join(downloadDir, selected.fileName);
    await download(`${MAC_RELEASE_BASE}/${selected.fileName}`, dmgPath, emit);
    verifyDownload(dmgPath, selected.expected);
  }

  try {
    await run("hdiutil", ["verify", dmgPath], emit);
    await run("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountDir], emit);

    const mountedApp = findApp(mountDir);
    if (!mountedApp) {
      throw new Error(`Could not find a supported ${TRITONAI_APP_DISPLAY_NAME} app in the mounted installer image.`);
    }

    await replaceMacAppTransactionally({
      sourceAppPath: mountedApp,
      managedAppPath,
      emit
    });
  } finally {
    await run("hdiutil", ["detach", mountDir], emit, { allowFailure: true });
    fs.rmSync(mountDir, { recursive: true, force: true });
  }

  const shortcutPath = writeMacAppLauncher(paths, emit, arch);
  emit(`${TRITONAI_LAUNCHER_NAME} launcher installed at ${shortcutPath}`);
  return { appPath: shortcutPath || managedAppPath, shortcutPath };
}

async function replaceMacAppTransactionally({
  sourceAppPath,
  managedAppPath,
  emit,
  copyApp = null,
  validateStagedApp = null
}) {
  validateMacAppBundle(sourceAppPath, "Mounted");
  const parent = path.dirname(managedAppPath);
  fs.mkdirSync(parent, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(parent, ".tritonai-harness-stage-"));
  const stagedAppPath = path.join(stageRoot, path.basename(managedAppPath));
  const backupRoot = fs.mkdtempSync(path.join(parent, ".tritonai-harness-backup-"));
  const previousAppPath = path.join(backupRoot, path.basename(managedAppPath));
  let previousMoved = false;
  let replacementActivated = false;
  let replacementCompleted = false;

  try {
    if (copyApp) {
      await copyApp(sourceAppPath, stagedAppPath);
    } else {
      await run("ditto", [sourceAppPath, stagedAppPath], emit);
    }
    validateMacAppBundle(stagedAppPath, "Staged");
    if (validateStagedApp) {
      await validateStagedApp(stagedAppPath);
    } else if (process.platform === "darwin") {
      await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", stagedAppPath], emit);
    }

    if (fs.existsSync(managedAppPath)) {
      fs.renameSync(managedAppPath, previousAppPath);
      previousMoved = true;
    }
    fs.renameSync(stagedAppPath, managedAppPath);
    replacementActivated = true;
    validateMacAppBundle(managedAppPath, "Installed");
    replacementCompleted = true;
  } catch (error) {
    if (previousMoved) {
      try {
        fs.rmSync(managedAppPath, { recursive: true, force: true });
        fs.renameSync(previousAppPath, managedAppPath);
        previousMoved = false;
      } catch (rollbackError) {
        throw new Error(
          `Could not replace ${TRITONAI_APP_DISPLAY_NAME}: ${error.message}. `
          + `Rollback also failed: ${rollbackError.message}`
        );
      }
    } else if (replacementActivated) {
      fs.rmSync(managedAppPath, { recursive: true, force: true });
    }
    throw error;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    if (replacementCompleted || !previousMoved) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  }
}

function validateMacAppBundle(appPath, label) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(infoPlist) || !fs.statSync(infoPlist).isFile()) {
    throw new Error(`${label} ${TRITONAI_APP_DISPLAY_NAME} app is missing Contents/Info.plist.`);
  }
  if (!fs.existsSync(macOsDir) || !fs.statSync(macOsDir).isDirectory()) {
    throw new Error(`${label} ${TRITONAI_APP_DISPLAY_NAME} app is missing Contents/MacOS.`);
  }
  const executables = fs.readdirSync(macOsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(macOsDir, entry.name));
  if (executables.length === 0) {
    throw new Error(`${label} ${TRITONAI_APP_DISPLAY_NAME} app has no executable under Contents/MacOS.`);
  }
}

async function installWindowsDesktop({
  paths,
  arch,
  emit,
  env,
  resourcesPath,
  appRoot,
  packaged,
  windowsInstallRuntime = {}
}) {
  const windowsRuntime = windowsInstallRuntime as WindowsInstallRuntime;
  const bundledInstaller = getBundledWindowsInstaller({ arch, resourcesPath, appRoot });
  const downloadDir = path.join(paths.cacheDir, "t3code-desktop");
  fs.mkdirSync(downloadDir, { recursive: true });

  let installerPath;
  let expectedVersion;
  if (bundledInstaller) {
    verifyDownload(bundledInstaller.installerPath, bundledInstaller.expected);
    installerPath = stageWindowsInstallerInCache(bundledInstaller.installerPath, downloadDir);
    expectedVersion = bundledInstaller.version;
    verifyDownload(installerPath, bundledInstaller.expected);
    emit(`Using bundled ${TRITONAI_APP_DISPLAY_NAME} installer staged at ${installerPath}`);
  } else if (packaged) {
    throw new Error(`This packaged TritonAI Installer is missing a valid bundled ${TRITONAI_APP_DISPLAY_NAME} Windows installer.`);
  } else {
    const manifestText = await downloadText(`${WIN_RELEASE_BASE}/${WIN_MANIFEST_FILE}`);
    const manifest = parseLatestYml(manifestText);
    const selected = selectWindowsInstaller(manifest, arch);
    installerPath = path.join(downloadDir, selected.fileName);
    expectedVersion = manifest.version;
    await download(`${WIN_RELEASE_BASE}/${selected.fileName}`, installerPath, emit);
    verifyDownload(installerPath, selected.expected);
  }

  const normalizedExpectedVersion = normalizeWindowsAppVersion(expectedVersion);
  if (!normalizedExpectedVersion) {
    throw new Error(`${TRITONAI_APP_DISPLAY_NAME} Windows manifest has an invalid version: ${expectedVersion || "missing"}`);
  }

  const existingAppPath = findWindowsT3CodeApp(paths.homeDir);
  const fingerprintReader = windowsRuntime.readWindowsAppFingerprint || readWindowsAppFingerprint;
  const existingAppFingerprint = existingAppPath
    ? await fingerprintReader(existingAppPath)
    : null;
  if (existingAppPath) {
    emit(`Found existing ${TRITONAI_APP_DISPLAY_NAME} install; running the bundled installer to update or repair it.`);
  }

  const unblock = windowsRuntime.unblockWindowsFile || unblockWindowsFile;
  const installerRunner = windowsRuntime.runWindowsInstaller || runWindowsInstaller;
  const appWaiter = windowsRuntime.waitForWindowsT3CodeApp || waitForWindowsT3CodeApp;
  const versionReader = windowsRuntime.readWindowsAppVersion || readWindowsAppVersion;
  const installFinisher = windowsRuntime.finishWindowsInstall || finishWindowsInstall;

  await unblock(installerPath, emit);
  emit(`Running ${TRITONAI_APP_DISPLAY_NAME} Windows installer...`);
  await installerRunner(installerPath, ["/S"], emit, env);

  const appPath = await appWaiter(paths.homeDir);
  if (!appPath) {
    throw new Error(`${TRITONAI_APP_DISPLAY_NAME} installer finished, but the app executable was not found in the current user's app folders.`);
  }

  const installedVersion = normalizeWindowsAppVersion(await versionReader(appPath, emit));
  if (installedVersion !== normalizedExpectedVersion) {
    throw new Error(
      `${TRITONAI_APP_DISPLAY_NAME} installer did not install the bundled version ${normalizedExpectedVersion}; `
      + `found ${installedVersion || "an unreadable version"} at ${appPath}.`
    );
  }

  if (
    existingAppPath
    && path.resolve(existingAppPath).toLowerCase() === path.resolve(appPath).toLowerCase()
    && existingAppFingerprint === await fingerprintReader(appPath)
  ) {
    throw new Error(
      `${TRITONAI_APP_DISPLAY_NAME} installer reported success but did not replace or refresh the existing app executable.`
    );
  }

  emit(`Verified ${TRITONAI_APP_DISPLAY_NAME} ${installedVersion} after the Windows installer completed.`);
  return installFinisher({ paths, appPath, emit });
}

async function finishWindowsInstall({ paths, appPath, emit }) {
  const shortcutPath = await createWindowsDesktopShortcut({ paths, appPath, emit });
  if (!shortcutPath) {
    throw new Error(`${TRITONAI_APP_DISPLAY_NAME} installed, but the desktop shortcut could not be created.`);
  }

  emit(`${TRITONAI_LAUNCHER_NAME} launcher created.`);
  return { appPath, shortcutPath };
}

function writeMacAppLauncher(paths, emit, arch) {
  const contentsDir = path.join(MAC_TRITONAI_APP_PATH, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  const executablePath = path.join(macosDir, MAC_LAUNCHER_EXECUTABLE_NAME);
  const nodeBinary = getNodeRuntimePaths(paths, "darwin", arch).nodeBinary;
  const managedAppPath = getManagedMacAppPath(paths);

  try {
    fs.rmSync(MAC_TRITONAI_APP_PATH, { recursive: true, force: true });
    fs.mkdirSync(macosDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });
    const iconFile = copyMacLauncherIcon(managedAppPath, resourcesDir, emit)
      ? MAC_LAUNCHER_ICON_FILE
      : null;
    fs.writeFileSync(path.join(contentsDir, "Info.plist"), macInfoPlist(iconFile));
    fs.writeFileSync(executablePath, buildMacLauncherScript(paths, nodeBinary, managedAppPath), { mode: 0o755 });
    return MAC_TRITONAI_APP_PATH;
  } catch (error) {
    emit(`Could not create ${TRITONAI_LAUNCHER_NAME} launcher app: ${error.message}`);
    return null;
  }
}

function buildMacLauncherScript(paths, nodeBinary, managedAppPath) {
  return `#!/usr/bin/env sh
set -eu
if [ -f "${paths.envFile}" ]; then
  # shellcheck disable=SC1090
  . "${paths.envFile}"
fi
export TRITONAI_HOME="${paths.t3Home}"
if [ -x "${nodeBinary}" ] && [ -f "${paths.t3DefaultsPatcher}" ]; then
  "${nodeBinary}" "${paths.t3DefaultsPatcher}" >/dev/null 2>&1 || true
elif [ -f "${paths.t3DefaultsPatcher}" ]; then
  node "${paths.t3DefaultsPatcher}" >/dev/null 2>&1 || true
fi
APP_PATH="${managedAppPath}"
APP_EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")
exec "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE" "$@"
`;
}

function getManagedMacAppPath(paths) {
  return path.join(paths.ucsdRoot, "apps", MAC_MANAGED_APP_NAME);
}

function macInfoPlist(iconFile = MAC_LAUNCHER_ICON_FILE) {
  const iconEntry = iconFile
    ? `  <key>CFBundleIconFile</key>
  <string>${escapeXml(iconFile)}</string>
`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${escapeXml(MAC_LAUNCHER_EXECUTABLE_NAME)}</string>
  <key>CFBundleIdentifier</key>
  <string>edu.ucsd.ai.tritonai-harness-launcher</string>
  <key>CFBundleName</key>
  <string>${escapeXml(TRITONAI_LAUNCHER_NAME)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(TRITONAI_LAUNCHER_NAME)}</string>
${iconEntry}  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
</dict>
</plist>
`;
}

function copyMacLauncherIcon(managedAppPath, resourcesDir, emit: InstallerEmit = () => {}) {
  const iconSource = getMacAppIconSource(managedAppPath);
  if (!iconSource) {
    emit(`Could not find a ${TRITONAI_APP_DISPLAY_NAME} app icon to copy from ${managedAppPath}.`);
    return false;
  }

  fs.copyFileSync(iconSource, path.join(resourcesDir, MAC_LAUNCHER_ICON_FILE));
  return true;
}

function getMacAppIconSource(appPath) {
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  if (!fs.existsSync(resourcesDir)) return null;

  const plistIconFile = readMacBundleIconFile(appPath);
  for (const candidate of macIconCandidates(resourcesDir, plistIconFile)) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const fallback = fs.readdirSync(resourcesDir)
    .filter((entry) => entry.toLowerCase().endsWith(".icns"))
    .sort((left, right) => {
      if (left === "icon.icns") return -1;
      if (right === "icon.icns") return 1;
      return left.localeCompare(right);
    })[0];

  return fallback ? path.join(resourcesDir, fallback) : null;
}

function readMacBundleIconFile(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) return null;

  const plist = fs.readFileSync(plistPath, "utf8");
  const match = plist.match(/<key>\s*CFBundleIconFile\s*<\/key>\s*<string>\s*([^<]+)\s*<\/string>/);
  return match ? match[1].trim() : null;
}

function macIconCandidates(resourcesDir, iconFile) {
  if (!iconFile) return [];

  const candidates = [iconFile];
  if (!iconFile.toLowerCase().endsWith(".icns")) {
    candidates.push(`${iconFile}.icns`);
  }

  return candidates.map((entry) => path.join(resourcesDir, entry));
}

function buildWindowsEnvironmentScript(paths) {
  return `
if (Test-Path '${escapePowerShellSingleQuoted(paths.envFile)}') {
  . '${escapePowerShellSingleQuoted(paths.envFile)}'
}
$env:TRITONAI_HOME = '${escapePowerShellSingleQuoted(paths.t3Home)}'
`;
}

async function createWindowsDesktopShortcut({ paths, appPath, emit }) {
  const shortcutName = `${TRITONAI_LAUNCHER_NAME}.lnk`;
  const fallbackShortcutPath = path.join(paths.homeDir, "Desktop", shortcutName);

  if (process.platform !== "win32") {
    emit(`Windows desktop shortcut creation requires Windows; skipping ${TRITONAI_LAUNCHER_NAME} shortcut creation in this environment.`);
    return fallbackShortcutPath;
  }

  const launcherPath = writeWindowsLauncherScript({ paths, appPath, emit });
  const command = buildWindowsDesktopShortcutScript({ paths, appPath, launcherPath, shortcutName });
  const output = await runPowerShellCapture(command, emit);
  const shortcutPath = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || fallbackShortcutPath;
  emit(`Created ${TRITONAI_LAUNCHER_NAME} desktop shortcut: ${shortcutPath}`);
  return shortcutPath;
}

function writeWindowsLauncherScript({ paths, appPath, emit }) {
  const launcherPath = path.join(paths.binDir, "tritonai-harness-launcher.ps1");
  const workingDirectory = paths.platform === "win32" ? path.win32.dirname(appPath) : path.dirname(appPath);
  const nodeBinary = getNodeRuntimePaths(paths, "win32", "x64").nodeBinary;

  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  fs.writeFileSync(launcherPath, `${buildWindowsEnvironmentScript(paths)}
$nodePath = '${escapePowerShellSingleQuoted(nodeBinary)}'
$defaultsPatcher = '${escapePowerShellSingleQuoted(paths.t3DefaultsPatcher)}'
if ((Test-Path $nodePath) -and (Test-Path $defaultsPatcher)) {
  try {
    & $nodePath $defaultsPatcher | Out-Null
  } catch {
  }
}
$appPath = '${escapePowerShellSingleQuoted(appPath)}'
$workingDirectory = '${escapePowerShellSingleQuoted(workingDirectory)}'
if (Test-Path $appPath) {
  Start-Process -FilePath $appPath -WorkingDirectory $workingDirectory | Out-Null
}
`);
  emit(`Created ${TRITONAI_LAUNCHER_NAME} Windows launcher: ${launcherPath}`);
  return launcherPath;
}

function buildWindowsDesktopShortcutScript({ paths, appPath, launcherPath, shortcutName = `${TRITONAI_LAUNCHER_NAME}.lnk` }) {
  const workingDirectory = paths.platform === "win32" ? path.win32.dirname(appPath) : path.dirname(appPath);
  const shortcutTargetPath = launcherPath ? "powershell.exe" : appPath;
  const shortcutArguments = launcherPath
    ? `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPath}"`
    : "";

  return `
$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop)) {
  $desktop = Join-Path $HOME 'Desktop'
}
New-Item -ItemType Directory -Force -Path $desktop | Out-Null
$shortcutPath = Join-Path $desktop '${escapePowerShellSingleQuoted(shortcutName)}'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = '${escapePowerShellSingleQuoted(shortcutTargetPath)}'
$shortcut.Arguments = '${escapePowerShellSingleQuoted(shortcutArguments)}'
$shortcut.WorkingDirectory = '${escapePowerShellSingleQuoted(workingDirectory)}'
$shortcut.Description = '${escapePowerShellSingleQuoted(TRITONAI_LAUNCHER_NAME)}'
$shortcut.IconLocation = '${escapePowerShellSingleQuoted(appPath)},0'
$shortcut.Save()
if (-not (Test-Path -LiteralPath $shortcutPath)) {
  throw "Shortcut was not created: $shortcutPath"
}
Write-Output $shortcutPath
`;
}

async function runWindowsInstaller(installerPath, args, emit, env) {
  if (process.platform !== "win32") {
    await run(installerPath, args, emit, { env, shell: false });
    return;
  }

  try {
    await run(installerPath, args, emit, { env, shell: false });
    return;
  } catch (error) {
    if (!isPermissionError(error)) {
      emit(`Direct ${TRITONAI_APP_DISPLAY_NAME} installer launch failed: ${error.message}`);
    } else {
      emit(`Direct ${TRITONAI_APP_DISPLAY_NAME} installer launch was blocked by Windows (${error.code || "permission denied"}).`);
    }
  }

  const argumentList = args.join(" ");
  try {
    await runPowerShell([
      `$process = Start-Process -FilePath '${escapePowerShellSingleQuoted(installerPath)}'`,
      `-ArgumentList '${escapePowerShellSingleQuoted(argumentList)}'`,
      "-Wait -PassThru;",
      `Write-Output "${TRITONAI_APP_DISPLAY_NAME} installer exit code: $($process.ExitCode)";`,
      "exit $process.ExitCode"
    ].join(" "), emit, { env });
    return;
  } catch (powershellError) {
    emit(`PowerShell ${TRITONAI_APP_DISPLAY_NAME} installer launch failed: ${powershellError.message}`);
  }

  await run("cmd.exe", [
    "/d",
    "/s",
    "/c",
    `start "" /wait "${installerPath}" ${args.join(" ")}`
  ], emit, { env, shell: false });
}

async function readWindowsAppVersion(appPath, emit) {
  const output = await runPowerShellCapture(
    `[Diagnostics.FileVersionInfo]::GetVersionInfo('${escapePowerShellSingleQuoted(appPath)}').ProductVersion`,
    emit
  );
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || null;
}

function readWindowsAppFingerprint(appPath) {
  const stat = fs.statSync(appPath);
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function normalizeWindowsAppVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function stageWindowsInstallerInCache(source, downloadDir) {
  fs.mkdirSync(downloadDir, { recursive: true });
  const target = path.join(downloadDir, path.basename(source));
  if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
    fs.copyFileSync(source, target);
  }
  return target;
}

function getBundledMacDmg(options: DesktopBundleOptions = {}) {
  const archPart = macArchPart(options.arch || process.arch);
  const candidates = bundleBaseCandidates(options)
    .map((base) => path.join(base, "vendor", "t3code-desktop", `mac-${archPart}`));

  for (const vendorDir of candidates) {
    const manifestPath = path.join(vendorDir, MAC_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
    const selected = selectMacDmg(manifest, options.arch || process.arch);
    const dmgPath = path.join(vendorDir, selected.fileName);
    if (fs.existsSync(dmgPath)) {
      return { manifestPath, dmgPath, ...selected };
    }
  }

  return null;
}

function getBundledWindowsInstaller(options: DesktopBundleOptions = {}) {
  const archPart = windowsArchPart(options.arch || process.arch);
  const candidates = bundleBaseCandidates(options)
    .map((base) => path.join(base, "vendor", "t3code-desktop", `win-${archPart}`));

  for (const vendorDir of candidates) {
    const manifestPath = path.join(vendorDir, WIN_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
    const selected = selectWindowsInstaller(manifest, options.arch || process.arch);
    const installerPath = path.join(vendorDir, selected.fileName);
    if (fs.existsSync(installerPath)) {
      return { manifestPath, installerPath, version: manifest.version, ...selected };
    }
  }

  return null;
}

function bundleBaseCandidates(options: DesktopBundleOptions = {}): string[] {
  return [
    options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath,
    options.appRoot || defaultAppRoot(__dirname)
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function selectMacDmg(manifest, arch = process.arch) {
  const archPart = macArchPart(arch);
  const expectedName = `TritonAI-Harness-${manifest.version}-${archPart}.dmg`;
  return selectManifestFile(manifest, new RegExp(`^${escapeRegExp(expectedName)}$`));
}

function selectWindowsInstaller(manifest, arch = process.arch) {
  const archPart = windowsArchPart(arch);
  const expectedName = `TritonAI-Harness-${manifest.version}-${archPart}.exe`;
  return selectManifestFile(manifest, new RegExp(`^${escapeRegExp(expectedName)}$`));
}

function selectManifestFile(manifest, pattern) {
  const fileName = Object.keys(manifest.files || {}).find((entry) => pattern.test(entry));
  if (!fileName) {
    throw new Error(`${TRITONAI_APP_DISPLAY_NAME} manifest does not include an asset matching ${pattern}`);
  }

  return { fileName, expected: manifest.files[fileName] };
}

function parseLatestYml(text) {
  const result = { version: null, files: {} };
  let currentFile = null;

  for (const line of text.split(/\r?\n/)) {
    const versionMatch = line.match(/^version:\s+(.+)\s*$/);
    if (versionMatch) {
      result.version = cleanYamlValue(versionMatch[1]);
      continue;
    }

    const urlMatch = line.match(/^\s*-\s+url:\s+(.+)\s*$/);
    if (urlMatch) {
      currentFile = cleanYamlValue(urlMatch[1]);
      result.files[currentFile] = {};
      continue;
    }

    const propertyMatch = line.match(/^\s+(sha512|size):\s+(.+)\s*$/);
    if (currentFile && propertyMatch) {
      const [, key, rawValue] = propertyMatch;
      result.files[currentFile][key] = key === "size"
        ? Number(cleanYamlValue(rawValue))
        : cleanYamlValue(rawValue);
    }
  }

  return result;
}

function cleanYamlValue(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function macArchPart(arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  throw new Error(`Unsupported macOS architecture for ${TRITONAI_APP_DISPLAY_NAME}: ${arch}`);
}

function windowsArchPart(arch) {
  if (arch === "x64") return "x64";
  throw new Error(`Unsupported Windows architecture for ${TRITONAI_APP_DISPLAY_NAME}: ${arch}`);
}

function findApp(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const direct = entries.find((entry) => entry.isDirectory() && MAC_SOURCE_APP_NAMES.includes(entry.name));
  if (direct) return path.join(root, direct.name);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(".app")) continue;
    const nested = findApp(path.join(root, entry.name));
    if (nested) return nested;
  }

  return null;
}

function findWindowsT3CodeApp(homeDir = os.homedir()) {
  const homeLocalAppData = path.join(homeDir, "AppData", "Local");
  const localAppData = process.env.LOCALAPPDATA || homeLocalAppData;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const candidateRoots = [
    path.join(homeLocalAppData, "Programs"),
    homeLocalAppData,
    path.join(localAppData, "Programs"),
    localAppData,
    programFiles,
    programFilesX86
  ].filter(Boolean);
  const candidates = mergeUnique(
    candidateRoots.flatMap((root) => WIN_INSTALL_DIR_NAMES.map((dirName) => path.join(root, dirName))),
    candidateRoots
  );

  for (const dir of candidates) {
    const appPath = WIN_EXE_NAMES.map((fileName) => findFile(dir, fileName, 3)).find(Boolean);
    if (appPath) return appPath;
  }

  return null;
}

async function waitForWindowsT3CodeApp(homeDir) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const appPath = findWindowsT3CodeApp(homeDir);
    if (appPath) return appPath;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

function findFile(root, fileName, maxDepth) {
  return findFileByPredicate(root, (candidate) => candidate.toLowerCase() === fileName.toLowerCase(), maxDepth);
}

function findFileByPredicate(root, predicate, maxDepth) {
  if (!root || maxDepth < 0 || !fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isPermissionError(error)) return null;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && predicate(entry.name)) {
      return fullPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findFileByPredicate(path.join(root, entry.name), predicate, maxDepth - 1);
    if (nested) return nested;
  }

  return null;
}

function mergeUnique(...groups) {
  const values = [];
  const seen = new Set();
  for (const group of groups) {
    for (const value of group || []) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function verifyDownload(file, expected) {
  const stat = fs.statSync(file);
  if (Number.isFinite(expected.size) && stat.size !== expected.size) {
    throw new Error(`Size mismatch for ${path.basename(file)}: expected ${expected.size}, got ${stat.size}`);
  }

  const actual = crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
  if (actual !== expected.sha512) {
    throw new Error(`SHA-512 mismatch for ${path.basename(file)}`);
  }
}

function download(url, target, emit) {
  return new Promise((resolve, reject) => {
    fs.rmSync(target, { force: true });
    emit(`Downloading ${url}`);

    const file = fs.createWriteStream(target);
    file.on("error", (error) => {
      fs.rmSync(target, { force: true });
      reject(error);
    });
    https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        file.close();
        fs.rmSync(target, { force: true });
        download(new URL(response.headers.location, url).toString(), target, emit).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.rmSync(target, { force: true });
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (error) => {
      file.close();
      fs.rmSync(target, { force: true });
      reject(error);
    });
  });
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        downloadText(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

async function unblockWindowsFile(file, emit) {
  if (process.platform !== "win32") return;

  await runPowerShell(`Unblock-File -LiteralPath '${escapePowerShellSingleQuoted(file)}'`, emit, { allowFailure: true });
}

function run(command, args, emit, options: CommandOptions = {}) {
  return new Promise<void>((resolve, reject) => {
    emit(`$ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      env: options.env || process.env,
      shell: Object.prototype.hasOwnProperty.call(options, "shell") ? options.shell : process.platform === "win32"
    });
    child.stdout.on("data", (chunk) => emit(clean(chunk)));
    child.stderr.on("data", (chunk) => emit(clean(chunk)));
    child.on("error", (error) => {
      if (options.allowFailure) {
        emit(`${command} failed: ${error.message}`);
        resolve();
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        if (code !== 0) emit(`${command} exited with ${code}; continuing.`);
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function runCapture(command, args, emit, options: CommandOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    emit(`$ ${command} ${args.join(" ")}`);
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      env: options.env || process.env,
      shell: Object.prototype.hasOwnProperty.call(options, "shell") ? options.shell : process.platform === "win32"
    });
    child.stdout.on("data", (chunk) => {
      const text = clean(chunk);
      stdout += chunk.toString("utf8");
      if (text) emit(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = clean(chunk);
      stderr += chunk.toString("utf8");
      if (text) emit(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });
  });
}

function runPowerShell(script, emit, options: CommandOptions = {}) {
  return run("powershell.exe", powerShellArgs(script), emit, { ...options, shell: false });
}

function runPowerShellCapture(script, emit, options: CommandOptions = {}) {
  return runCapture("powershell.exe", powerShellArgs(script), emit, { ...options, shell: false });
}

function powerShellArgs(script) {
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ];
}

function isPermissionError(error) {
  return ["EACCES", "EPERM"].includes(error && error.code)
    || /EPERM|EACCES|permission denied/i.test(error && error.message);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clean(chunk) {
  return chunk.toString("utf8").replace(/\n+$/g, "");
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''");
}

module.exports = {
  installT3CodeDesktop,
  installWindowsDesktop,
  replaceMacAppTransactionally,
  getBundledMacDmg,
  getBundledWindowsInstaller,
  parseLatestYml,
  selectMacDmg,
  selectWindowsInstaller,
  macInfoPlist,
  getMacAppIconSource,
  buildMacLauncherScript,
  buildWindowsEnvironmentScript,
  buildWindowsDesktopShortcutScript,
  findWindowsT3CodeApp,
  normalizeWindowsAppVersion,
  getManagedMacAppPath
};
