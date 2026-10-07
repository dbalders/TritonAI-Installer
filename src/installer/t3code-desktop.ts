import { fileDigest } from "./file-digest";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { defaultAppRoot } = require("./app-root");
const {
  recoverInterruptedDirectoryTransaction,
  writeDirectoryTransactionJournal
} = require("./directory-transaction");
const {
  EXPECTED_MAC_HARNESS_BUNDLE_ID,
  MACOS_CODESIGN_PATH,
  MACOS_PLUTIL_PATH,
  assertExpectedMacHarnessBundleIdentifier,
  macHarnessBundleIdentifierPlistArgs,
  macHarnessCodesignVerificationArgs
} = require("./macos-harness-identity");
const { downloadFileAtomic, getNodeRuntimePaths } = require("./prerequisites");
const { writeFileAtomic } = require("./atomic-file");
const { terminateProcessTree } = require("./process-termination");
const { EXPECTED_WINDOWS_PUBLISHER_NAME } = require("./windows-publisher-identity");
const {
  WINDOWS_ARTIFACT_TRUST_FILE,
  readWindowsArtifactTrustPolicy
} = require("./windows-artifact-trust");
const { spawn } = require("child_process");

const RELEASE_BASE = "https://github.com/dbalders/TritonAI-Harness/releases/latest/download";
const MAC_RELEASE_BASE = RELEASE_BASE;
const WIN_RELEASE_BASE = RELEASE_BASE;
const TRITONAI_APP_DISPLAY_NAME = "TritonAI Harness";
const MAC_MANAGED_APP_NAME = `${TRITONAI_APP_DISPLAY_NAME}.app`;
const MAC_SYSTEM_APPLICATIONS_DIR = "/Applications";
const MAC_MANIFEST_FILE = "latest-mac.yml";
const WIN_MANIFEST_FILE = "latest.yml";
const TRITONAI_LAUNCHER_NAME = TRITONAI_APP_DISPLAY_NAME;
const MAC_APP_BUNDLE_ID = EXPECTED_MAC_HARNESS_BUNDLE_ID;
const MAC_SOURCE_APP_NAMES = [
  MAC_MANAGED_APP_NAME
];
const WIN_EXE_NAMES = [
  "TritonAI Harness.exe"
];
const WIN_INSTALL_DIR_NAMES = [
  "TritonAI Harness"
];
const WIN_INSTALL_COMPLETE_MARKER = ".tritonai-install-complete";
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const WINDOWS_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const RELEASE_DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const RELEASE_MANIFEST_MAX_BYTES = 1024 * 1024;
const MAC_APP_TRANSACTION_JOURNAL_FILE = ".tritonai-harness-app-transaction.json";
const MAC_APP_STAGE_PREFIX = ".tritonai-harness-stage-";
const MAC_APP_BACKUP_PREFIX = ".tritonai-harness-backup-";
const MAC_APP_TRANSACTION_KIND = "managed TritonAI Harness app";
const MAC_APPLICATIONS_WRITE_PROBE_PREFIX = ".tritonai-harness-write-probe-";
const MAC_REMOVED_ENTRY_PREFIX = ".tritonai-harness-removed-";
const MAC_LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;
// Earlier Installers wrote an unsigned shell launcher into Applications and kept the
// signed app under ~/.agents/ucsd/apps. These names identify what upgrades must clean up.
const LEGACY_MAC_LAUNCHER_BUNDLE_ID = "edu.ucsd.ai.tritonai-harness-launcher";
const LEGACY_MAC_LAUNCHER_TRANSACTION_JOURNAL_FILE = ".tritonai-harness-launcher-transaction.json";
const LEGACY_MAC_LAUNCHER_STAGE_PREFIX = ".tritonai-harness-launcher-stage-";
const LEGACY_MAC_LAUNCHER_BACKUP_PREFIX = ".tritonai-harness-launcher-backup-";

interface DesktopBundleOptions {
  arch?: NodeJS.Architecture;
  resourcesPath?: string;
  appRoot?: string;
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  allowFailure?: boolean;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  terminate?: typeof terminateProcessTree;
}

interface WindowsInstallRuntime {
  verifyExpectedWindowsHarnessPublisher?: typeof verifyExpectedWindowsHarnessPublisher;
  unblockWindowsFile?: typeof unblockWindowsFile;
  runWindowsInstaller?: typeof runWindowsInstaller;
  waitForWindowsT3CodeApp?: typeof waitForWindowsT3CodeApp;
  readWindowsAppVersion?: typeof readWindowsAppVersion;
  readWindowsAppFingerprint?: typeof readWindowsAppFingerprint;
  finishWindowsInstall?: typeof finishWindowsInstall;
  cleanupStaleWindowsUpgradeBackup?: typeof cleanupStaleWindowsUpgradeBackup;
}

interface WindowsInstallerCommandRuntime {
  platform?: NodeJS.Platform;
  run?: typeof run;
  runPowerShellCapture?: typeof runPowerShellCapture;
}

interface MacAppPlacementRuntime {
  systemApplicationsDir?: string;
  replaceApp?: typeof replaceMacAppTransactionally;
  readAppVersion?: (appPath: string) => Promise<string | null>;
  verifyInstalledApp?: (appPath: string) => Promise<void>;
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
  fs.mkdirSync(downloadDir, { recursive: true });

  let dmgPath;
  let appPath = null;
  if (bundledDmg) {
    dmgPath = bundledDmg.dmgPath;
    verifyDownload(dmgPath, bundledDmg.expected);
    emit(`Installing ${TRITONAI_APP_DISPLAY_NAME} from bundled image at ${dmgPath}`);
    emit(`Using signed app-bundled ${TRITONAI_APP_DISPLAY_NAME} image; validating with hdiutil before install.`);
  } else if (packaged) {
    throw new Error(`This packaged TritonAI Installer is missing a valid bundled ${TRITONAI_APP_DISPLAY_NAME} macOS image.`);
  } else {
    const manifestText = await downloadText(`${MAC_RELEASE_BASE}/${MAC_MANIFEST_FILE}`, emit);
    const manifest = parseLatestYml(manifestText);
    const selected = selectMacDmg(manifest, arch);
    dmgPath = path.join(downloadDir, selected.fileName);
    await download(`${MAC_RELEASE_BASE}/${selected.fileName}`, dmgPath, emit);
    verifyDownload(dmgPath, selected.expected);
  }

  try {
    await run("hdiutil", ["verify", dmgPath], emit);
    emit(`Verified ${TRITONAI_APP_DISPLAY_NAME} installer image.`);
    await run("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountDir], emit);
    emit(`Mounted ${TRITONAI_APP_DISPLAY_NAME} installer image.`);

    const mountedApp = findApp(mountDir);
    if (!mountedApp) {
      throw new Error(`Could not find a supported ${TRITONAI_APP_DISPLAY_NAME} app in the mounted installer image.`);
    }

    appPath = await installMacApp({ sourceAppPath: mountedApp, paths, emit });
  } finally {
    if (appPath) {
      emit(`Closing ${TRITONAI_APP_DISPLAY_NAME} installer image.`);
    }
    await run("hdiutil", ["detach", mountDir], emit, { allowFailure: true });
    fs.rmSync(mountDir, { recursive: true, force: true });
  }

  emit(`Closed ${TRITONAI_APP_DISPLAY_NAME} installer image.`);
  emit(`${TRITONAI_APP_DISPLAY_NAME} installed in Applications at ${appPath}`);
  return { appPath, shortcutPath: appPath };
}

// Install the signed, notarized Harness itself into Applications. Shared /Applications needs an
// admin account, which is also what the Harness updater needs to replace it later, so standard
// accounts get a per-user copy in ~/Applications that they can keep updated themselves.
async function installMacApp({
  sourceAppPath,
  paths,
  emit,
  runtime = {}
}: {
  sourceAppPath: string;
  paths: { homeDir: string; ucsdRoot: string };
  emit: InstallerEmit;
  runtime?: MacAppPlacementRuntime;
}) {
  const systemApplicationsDir = runtime.systemApplicationsDir || MAC_SYSTEM_APPLICATIONS_DIR;
  const userApplicationsDir = path.join(paths.homeDir, "Applications");
  const placement = {
    bundledAppPath: sourceAppPath,
    // Every location an earlier install, self-update, or manual copy may have left a Harness in.
    existingAppPaths: [
      getLegacyMacAppPath(paths),
      path.join(systemApplicationsDir, MAC_MANAGED_APP_NAME),
      path.join(userApplicationsDir, MAC_MANAGED_APP_NAME)
    ],
    emit,
    replaceApp: runtime.replaceApp || replaceMacAppTransactionally,
    readAppVersion: runtime.readAppVersion || ((appPath) => readMacHarnessVersion(appPath, emit)),
    verifyInstalledApp: runtime.verifyInstalledApp || ((appPath) => verifyExpectedMacHarnessPublisher(appPath, emit))
  };
  const userAppPath = path.join(userApplicationsDir, MAC_MANAGED_APP_NAME);
  let appPath = path.join(systemApplicationsDir, MAC_MANAGED_APP_NAME);
  if (!canCreateEntriesIn(systemApplicationsDir)) {
    appPath = userAppPath;
    emit(
      `The shared Applications folder is not writable for this account; `
      + `installing ${TRITONAI_APP_DISPLAY_NAME} for this user in ${userApplicationsDir} instead.`
    );
  }
  try {
    await placeNewestMacApp({ ...placement, appPath });
  } catch (error) {
    // Creating entries is not proof that an existing bundle can be replaced (another account's
    // bundle, App Management). Fall back only when the transaction left the shared copy intact.
    if (appPath === userAppPath || !isPermissionError(error) || error.rollbackFailed) throw error;
    emit(
      `Could not replace ${appPath} (${error.message}); `
      + `installing ${TRITONAI_APP_DISPLAY_NAME} for this user in ${userApplicationsDir} instead.`
    );
    appPath = userAppPath;
    await placeNewestMacApp({ ...placement, appPath });
  }
  removeLegacyMacInstall({
    paths,
    appPath,
    applicationsDirs: [systemApplicationsDir, userApplicationsDir],
    emit
  });
  return appPath;
}

// Rerunning an older Installer must not roll back a Harness that already updated itself: an
// older app can't open state a newer one has migrated. Install whichever trusted copy is newest,
// even when that is the app already at the target, so it is still stopped, re-verified, and
// cleared of quarantine through the same transaction.
async function placeNewestMacApp({
  bundledAppPath,
  existingAppPaths,
  appPath,
  emit,
  replaceApp,
  readAppVersion,
  verifyInstalledApp
}) {
  // An interrupted swap can hold the newest app in its backup; restore it before comparing.
  for (const candidate of [...new Set(existingAppPaths.map((entry) => path.resolve(entry)))]) {
    try {
      recoverInterruptedMacAppSwap(candidate, emit);
    } catch (error) {
      if (path.resolve(candidate) === path.resolve(appPath)) throw error;
      emit(`Left the interrupted ${TRITONAI_APP_DISPLAY_NAME} install at ${path.dirname(candidate)} for recovery: ${error.message}`);
    }
  }
  const bundledVersion = await readAppVersion(bundledAppPath);
  let sourceAppPath = bundledAppPath;
  let sourceVersion = bundledVersion;
  for (const candidate of [...new Set(existingAppPaths.map((entry) => path.resolve(entry)))]) {
    if (!fs.existsSync(candidate) || isLegacyMacLauncher(candidate)) continue;
    const version = await readAppVersion(candidate);
    if (isNewerMacAppVersion(version, sourceVersion) && await isTrustedMacApp(candidate, verifyInstalledApp, emit)) {
      sourceAppPath = candidate;
      sourceVersion = version;
    }
  }
  if (sourceAppPath !== bundledAppPath) {
    emit(`Using the newer ${TRITONAI_APP_DISPLAY_NAME} ${sourceVersion} from ${sourceAppPath} instead of the bundled ${bundledVersion}.`);
  }
  await replaceApp({ sourceAppPath, managedAppPath: appPath, emit });
}

async function isTrustedMacApp(appPath, verifyInstalledApp, emit) {
  try {
    await verifyInstalledApp(appPath);
    return true;
  } catch (error) {
    emit(`Ignoring the ${TRITONAI_APP_DISPLAY_NAME} at ${appPath} because it failed verification: ${error.message}`);
    return false;
  }
}

async function readMacHarnessVersion(appPath, emit) {
  try {
    const version = await runCapture(
      MACOS_PLUTIL_PATH,
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")],
      emit,
      { shell: false }
    );
    return String(version).trim() || null;
  } catch {
    return null;
  }
}

function isNewerMacAppVersion(candidate, baseline) {
  const left = parseMacAppVersion(candidate);
  const right = parseMacAppVersion(baseline);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index];
  }
  if (left.prerelease === right.prerelease) return false;
  if (!left.prerelease) return true;
  if (!right.prerelease) return false;
  return comparePrerelease(left.prerelease, right.prerelease) > 0;
}

function parseMacAppVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version || "").trim());
  return match
    ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || "" }
    : null;
}

function comparePrerelease(left, right) {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b);
    const order = numeric ? Number(a) - Number(b) : a.localeCompare(b);
    if (order !== 0) return order;
  }
  return 0;
}

function canCreateEntriesIn(directory) {
  let probe = null;
  try {
    probe = fs.mkdtempSync(path.join(directory, MAC_APPLICATIONS_WRITE_PROBE_PREFIX));
    return true;
  } catch (error) {
    if (isPermissionError(error) || error.code === "ENOENT") return false;
    throw error;
  } finally {
    if (probe) fs.rmSync(probe, { recursive: true, force: true });
  }
}

// Cleanup runs only after the new app is active and is best-effort: a leftover legacy file must
// not fail an install whose app is already in place.
function removeLegacyMacInstall({ paths, appPath, applicationsDirs, emit }) {
  let survivingLauncher = null;
  for (const applicationsDir of [...new Set(applicationsDirs)]) {
    const candidate = path.join(applicationsDir, MAC_MANAGED_APP_NAME);
    if (path.resolve(candidate) !== path.resolve(appPath)
      && isLegacyMacLauncher(candidate)
      && !removeLegacyMacEntry(candidate, `old ${TRITONAI_LAUNCHER_NAME} launcher`, emit)) {
      survivingLauncher = candidate;
    }
    // A journal means an interrupted app swap whose backup is recovery evidence; leave those.
    const appTransactionLeftovers = fs.existsSync(path.join(applicationsDir, MAC_APP_TRANSACTION_JOURNAL_FILE))
      ? []
      : [MAC_APP_STAGE_PREFIX, MAC_APP_BACKUP_PREFIX];
    // Another account's Installer may be staging in the shared folder right now; only sweep
    // leftovers old enough that no live install could still own them.
    removeLegacyMacTransactionLeftovers(applicationsDir, [
      LEGACY_MAC_LAUNCHER_TRANSACTION_JOURNAL_FILE,
      LEGACY_MAC_LAUNCHER_STAGE_PREFIX,
      LEGACY_MAC_LAUNCHER_BACKUP_PREFIX,
      MAC_APPLICATIONS_WRITE_PROBE_PREFIX,
      MAC_REMOVED_ENTRY_PREFIX,
      ...appTransactionLeftovers
    ], emit);
  }

  const legacyAppPath = getLegacyMacAppPath(paths);
  if (survivingLauncher) {
    // The old launcher still opens this account's previous copy, so removing it would leave a
    // launcher (and any Dock icon pointing at it) that silently does nothing.
    emit(
      `An older ${TRITONAI_LAUNCHER_NAME} launcher at ${survivingLauncher} can't be removed by this account, `
      + `so the previous app copy it opens was kept. Open ${TRITONAI_APP_DISPLAY_NAME} from ${appPath} `
      + `instead (and replace any Dock icon), or ask an administrator to rerun the Installer.`
    );
    return;
  }

  const legacyAppsDir = path.dirname(legacyAppPath);
  if (fs.existsSync(path.join(legacyAppsDir, MAC_APP_TRANSACTION_JOURNAL_FILE))) {
    emit(`Kept ${legacyAppsDir} because it holds an interrupted install that could not be recovered.`);
    return;
  }
  removeLegacyMacEntry(legacyAppPath, `previous ${TRITONAI_APP_DISPLAY_NAME} copy`, emit);
  removeLegacyMacTransactionLeftovers(legacyAppsDir, [
    MAC_APP_TRANSACTION_JOURNAL_FILE,
    MAC_APP_STAGE_PREFIX,
    MAC_APP_BACKUP_PREFIX,
    MAC_REMOVED_ENTRY_PREFIX
  ], emit);
  try {
    if (fs.existsSync(legacyAppsDir) && fs.readdirSync(legacyAppsDir).length === 0) fs.rmdirSync(legacyAppsDir);
  } catch {
    // An empty legacy folder is harmless.
  }
}

// Move the entry out of its public name first so a partial delete can never leave a broken bundle
// behind; returns false only when the entry is still in place.
function removeLegacyMacEntry(target, label, emit) {
  if (!fs.existsSync(target)) return true;
  const removed = path.join(path.dirname(target), `${MAC_REMOVED_ENTRY_PREFIX}${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.renameSync(target, removed);
  } catch (error) {
    emit(`Could not remove ${label} at ${target}: ${error.message}`);
    return false;
  }
  try {
    fs.rmSync(removed, { recursive: true, force: true });
  } catch (error) {
    emit(`Moved ${label} away from ${target} but could not finish deleting ${removed}: ${error.message}`);
  }
  emit(`Removed ${label} at ${target}.`);
  return true;
}

function removeLegacyMacTransactionLeftovers(directory, names, emit, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!names.some((name) => entry === name || (name.endsWith("-") && entry.startsWith(name)))) continue;
    const target = path.join(directory, entry);
    try {
      if (now - fs.lstatSync(target).mtimeMs < MAC_LEFTOVER_MIN_AGE_MS) continue;
    } catch {
      continue;
    }
    removeLegacyMacEntry(target, "leftover install file", emit);
  }
}

function isLegacyMacLauncher(appPath) {
  try {
    if (fs.lstatSync(appPath).isSymbolicLink()) return false;
    return readMacBundlePlistString(appPath, "CFBundleIdentifier") === LEGACY_MAC_LAUNCHER_BUNDLE_ID;
  } catch {
    return false;
  }
}

async function replaceMacAppTransactionally({
  sourceAppPath,
  managedAppPath,
  emit,
  copyApp = null,
  validateStagedApp = null,
  stopRunningApp = stopRunningManagedMacApp
}) {
  validateMacAppBundle(sourceAppPath, "Source");
  const parent = path.dirname(managedAppPath);
  fs.mkdirSync(parent, { recursive: true });
  const journalPath = path.join(parent, MAC_APP_TRANSACTION_JOURNAL_FILE);
  recoverInterruptedMacAppSwap(managedAppPath, emit);
  const stageRoot = fs.mkdtempSync(path.join(parent, MAC_APP_STAGE_PREFIX));
  const stagedAppPath = path.join(stageRoot, path.basename(managedAppPath));
  const backupRoot = fs.mkdtempSync(path.join(parent, MAC_APP_BACKUP_PREFIX));
  const previousAppPath = path.join(backupRoot, path.basename(managedAppPath));
  let previousMoved = false;
  let replacementActivated = false;
  let replacementCompleted = false;

  try {
    if (copyApp) {
      await copyApp(sourceAppPath, stagedAppPath);
    } else {
      // A browser-downloaded Installer mounts its bundled image quarantined, and a plain copy
      // inherits com.apple.quarantine. Gatekeeper then evaluates the unstapled app on first launch:
      // an extra "downloaded from the Internet" prompt online, and "Apple could not verify" when
      // Apple's notarization lookup fails. The pinned publisher check below is the trust gate.
      await run("ditto", ["--noqtn", sourceAppPath, stagedAppPath], emit);
    }
    emit(`Copied ${TRITONAI_APP_DISPLAY_NAME} app to staging.`);
    validateMacAppBundle(stagedAppPath, "Staged");
    if (validateStagedApp) {
      await validateStagedApp(stagedAppPath);
    } else if (process.platform === "darwin") {
      await verifyExpectedMacHarnessPublisher(stagedAppPath, emit);
    }
    if (process.platform === "darwin") {
      // --noqtn only covers the mounted image; also clear an attribute set directly on the files.
      await clearMacQuarantine(stagedAppPath, emit);
    }
    emit(`Verified staged ${TRITONAI_APP_DISPLAY_NAME} app.`);

    await stopRunningApp({ emit });
    writeDirectoryTransactionJournal({
      journalPath,
      kind: MAC_APP_TRANSACTION_KIND,
      target: managedAppPath,
      stageRoot,
      backupRoot,
      stagePrefix: MAC_APP_STAGE_PREFIX,
      backupPrefix: MAC_APP_BACKUP_PREFIX,
      stagedName: path.basename(managedAppPath),
      backupName: path.basename(managedAppPath),
      hadPrevious: fs.existsSync(managedAppPath)
    });
    if (fs.existsSync(managedAppPath)) {
      fs.renameSync(managedAppPath, previousAppPath);
      previousMoved = true;
    }
    fs.renameSync(stagedAppPath, managedAppPath);
    replacementActivated = true;
    validateMacAppBundle(managedAppPath, "Installed");
    emit(`Installed ${TRITONAI_APP_DISPLAY_NAME} app at ${managedAppPath}.`);
    replacementCompleted = true;
  } catch (error) {
    if (previousMoved) {
      try {
        fs.rmSync(managedAppPath, { recursive: true, force: true });
        fs.renameSync(previousAppPath, managedAppPath);
        previousMoved = false;
      } catch (rollbackError) {
        throw Object.assign(new Error(
          `Could not replace ${TRITONAI_APP_DISPLAY_NAME}: ${error.message}. `
          + `Rollback also failed: ${rollbackError.message}`
        ), { rollbackFailed: true });
      }
    } else if (replacementActivated) {
      fs.rmSync(managedAppPath, { recursive: true, force: true });
    }
    throw error;
  } finally {
    // Cleanup is best-effort. After a completed swap the new app is already active, and a backup
    // this account can't delete (another account's old bundle) must not turn success into failure.
    removeMacTransactionPath(stageRoot, emit);
    if (replacementCompleted || !previousMoved) {
      removeMacTransactionPath(backupRoot, emit);
      // A completed rollback must not leave a journal pointing at deleted recovery directories.
      removeMacTransactionPath(journalPath, emit);
    }
  }
}

function recoverInterruptedMacAppSwap(appPath, emit) {
  return recoverInterruptedDirectoryTransaction({
    journalPath: path.join(path.dirname(appPath), MAC_APP_TRANSACTION_JOURNAL_FILE),
    kind: MAC_APP_TRANSACTION_KIND,
    target: appPath,
    stagePrefix: MAC_APP_STAGE_PREFIX,
    backupPrefix: MAC_APP_BACKUP_PREFIX,
    validate: (candidate) => {
      validateMacAppBundle(candidate, "Recovered");
      return true;
    },
    emit
  });
}

async function clearMacQuarantine(appPath, emit) {
  await run("/usr/bin/xattr", ["-d", "-r", "-s", "com.apple.quarantine", appPath], emit, { shell: false });
  // find lists only flagged entries (symlinks included), so the install log isn't flooded.
  const remaining = await runCapture("/usr/bin/find", [appPath, "-xattrname", "com.apple.quarantine"], emit, { shell: false });
  if (String(remaining).trim()) {
    throw new Error(`Could not clear the quarantine flag from the staged ${TRITONAI_APP_DISPLAY_NAME} app.`);
  }
}

function removeMacTransactionPath(target, emit) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    emit(`Could not remove leftover ${TRITONAI_APP_DISPLAY_NAME} install files at ${target}: ${error.message}`);
  }
}

async function verifyExpectedMacHarnessPublisher(
  appPath,
  emit,
  executeCodesign = run,
  readBundleIdentifier = readMacHarnessBundleIdentifier
) {
  assertExpectedMacHarnessBundleIdentifier(await readBundleIdentifier(appPath, emit));
  for (const args of macHarnessCodesignVerificationArgs(appPath)) {
    await executeCodesign(MACOS_CODESIGN_PATH, args, emit);
  }
}

function readMacHarnessBundleIdentifier(appPath, emit) {
  return runCapture(MACOS_PLUTIL_PATH, macHarnessBundleIdentifierPlistArgs(appPath), emit, { shell: false });
}

async function stopRunningManagedMacApp({ emit }) {
  if (process.platform !== "darwin") return;
  const script = `
ObjC.import("AppKit");
const running = () => $.NSRunningApplication
  .runningApplicationsWithBundleIdentifier("${MAC_APP_BUNDLE_ID}").js;
for (const app of running()) app.terminate;
for (let attempt = 0; attempt < 75 && running().length; attempt += 1) {
  $.NSThread.sleepForTimeInterval(0.2);
}
if (running().length) throw new Error("${TRITONAI_APP_DISPLAY_NAME} is still running");
`;
  emit(`Stopping any running ${TRITONAI_APP_DISPLAY_NAME} app before upgrading it...`);
  try {
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], emit, { shell: false });
  } catch (error) {
    throw new Error(
      `${TRITONAI_APP_DISPLAY_NAME} did not quit. Quit it manually and retry the upgrade; `
      + "the existing app was left unchanged.",
      { cause: error }
    );
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
  let windowsArtifactTrustMode = "authenticode";
  if (bundledInstaller) {
    verifyDownload(bundledInstaller.installerPath, bundledInstaller.expected);
    installerPath = stageWindowsInstallerInCache(bundledInstaller.installerPath, downloadDir);
    expectedVersion = bundledInstaller.version;
    windowsArtifactTrustMode = bundledInstaller.trustPolicy.mode;
    verifyDownload(installerPath, bundledInstaller.expected);
    emit(`Using bundled ${TRITONAI_APP_DISPLAY_NAME} installer staged at ${installerPath}`);
  } else if (packaged) {
    throw new Error(`This packaged TritonAI Installer is missing a valid bundled ${TRITONAI_APP_DISPLAY_NAME} Windows installer.`);
  } else {
    const manifestText = await downloadText(`${WIN_RELEASE_BASE}/${WIN_MANIFEST_FILE}`, emit);
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
    emit(`Found existing ${TRITONAI_APP_DISPLAY_NAME} install; its bundled NSIS upgrade will close it before replacement.`);
  }

  const unblock = windowsRuntime.unblockWindowsFile || unblockWindowsFile;
  const installerRunner = windowsRuntime.runWindowsInstaller || runWindowsInstaller;
  const appWaiter = windowsRuntime.waitForWindowsT3CodeApp || waitForWindowsT3CodeApp;
  const versionReader = windowsRuntime.readWindowsAppVersion || readWindowsAppVersion;
  const installFinisher = windowsRuntime.finishWindowsInstall || finishWindowsInstall;
  const upgradeBackupCleaner = windowsRuntime.cleanupStaleWindowsUpgradeBackup || cleanupStaleWindowsUpgradeBackup;
  const publisherVerifier = windowsRuntime.verifyExpectedWindowsHarnessPublisher || verifyExpectedWindowsHarnessPublisher;

  if (existingAppPath) {
    upgradeBackupCleaner({ appPath: existingAppPath, emit });
  }
  if (windowsArtifactTrustMode === "authenticode") {
    await publisherVerifier(installerPath, emit);
  } else {
    emit(
      `WARNING: This Windows release intentionally contains an unsigned ${TRITONAI_APP_DISPLAY_NAME}. `
      + "Its exact version and cryptographic release hash were verified, but Windows cannot verify a publisher until UC San Diego signing is available."
    );
  }
  await unblock(installerPath, emit);
  emit(`Running ${TRITONAI_APP_DISPLAY_NAME} Windows installer...`);
  await installerRunner(installerPath, ["/S"], emit, env);
  emit(`${TRITONAI_APP_DISPLAY_NAME} Windows installer completed.`);

  const appPath = await appWaiter(paths.homeDir);
  if (!appPath) {
    throw new Error(`${TRITONAI_APP_DISPLAY_NAME} installer finished, but the app executable was not found in the current user's app folders.`);
  }

  if (windowsArtifactTrustMode === "authenticode") {
    await publisherVerifier(appPath, emit);
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

function cleanupStaleWindowsUpgradeBackup({
  appPath,
  emit = (_message: string) => {},
  fsRuntime = fs,
  platform = process.platform
}) {
  const installDir = path.dirname(appPath);
  const completionMarker = path.join(installDir, WIN_INSTALL_COMPLETE_MARKER);
  const backupDir = `${installDir}.old`;
  if (!fsRuntime.existsSync(completionMarker) || !fsRuntime.existsSync(backupDir)) {
    return false;
  }

  emit(`Removing completed ${TRITONAI_APP_DISPLAY_NAME} upgrade backup at ${backupDir}...`);
  const removalTarget = platform === "win32" ? path.toNamespacedPath(backupDir) : backupDir;
  try {
    fsRuntime.rmSync(removalTarget, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    });
  } catch (error) {
    throw new Error(
      `Could not remove the completed ${TRITONAI_APP_DISPLAY_NAME} upgrade backup at ${backupDir}. `
      + `Restart Windows and run the installer again. ${error.message}`,
      { cause: error }
    );
  }

  if (fsRuntime.existsSync(backupDir)) {
    throw new Error(
      `Could not remove the completed ${TRITONAI_APP_DISPLAY_NAME} upgrade backup at ${backupDir}. `
      + "Restart Windows and run the installer again."
    );
  }

  emit(`Removed completed ${TRITONAI_APP_DISPLAY_NAME} upgrade backup.`);
  return true;
}

function getLegacyMacAppPath(paths) {
  return path.join(paths.ucsdRoot, "apps", MAC_MANAGED_APP_NAME);
}

function readMacBundlePlistString(appPath, key) {
  const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
  const match = plist.match(new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`));
  return match ? match[1] : null;
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
  writeFileAtomic(launcherPath, `\uFEFF${buildWindowsEnvironmentScript(paths)}
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
`, { mode: 0o600 });
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
$temporaryShortcutPath = "$shortcutPath.$PID.tmp.lnk"
$null = Remove-Item -LiteralPath $temporaryShortcutPath -Force -ErrorAction SilentlyContinue
$shell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shell.CreateShortcut($temporaryShortcutPath)
  $shortcut.TargetPath = '${escapePowerShellSingleQuoted(shortcutTargetPath)}'
  $shortcut.Arguments = '${escapePowerShellSingleQuoted(shortcutArguments)}'
  $shortcut.WorkingDirectory = '${escapePowerShellSingleQuoted(workingDirectory)}'
  $shortcut.Description = '${escapePowerShellSingleQuoted(TRITONAI_LAUNCHER_NAME)}'
  $shortcut.IconLocation = '${escapePowerShellSingleQuoted(appPath)},0'
  $shortcut.Save()
  Move-Item -LiteralPath $temporaryShortcutPath -Destination $shortcutPath -Force
} finally {
  Remove-Item -LiteralPath $temporaryShortcutPath -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath $shortcutPath)) {
  throw "Shortcut was not created: $shortcutPath"
}
Write-Output $shortcutPath
`;
}

async function runWindowsInstaller(
  installerPath,
  args,
  emit,
  env,
  commandRuntime: WindowsInstallerCommandRuntime = {}
) {
  const platform = commandRuntime.platform || process.platform;
  const commandRunner = commandRuntime.run || run;
  const powerShellCaptureRunner = commandRuntime.runPowerShellCapture || runPowerShellCapture;

  if (platform !== "win32") {
    await commandRunner(installerPath, args, emit, { env, shell: false, timeoutMs: WINDOWS_INSTALL_TIMEOUT_MS });
    return;
  }

  try {
    await commandRunner(installerPath, args, emit, { env, shell: false, timeoutMs: WINDOWS_INSTALL_TIMEOUT_MS });
    return;
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error;
    }
    emit(`Direct ${TRITONAI_APP_DISPLAY_NAME} installer launch was blocked by Windows (${error.code || "permission denied"}).`);
  }

  const argumentList = args.join(" ");
  let powerShellOutput;
  try {
    powerShellOutput = await powerShellCaptureRunner([
      "$ErrorActionPreference = 'Stop';",
      `$process = Start-Process -FilePath '${escapePowerShellSingleQuoted(installerPath)}'`,
      `  -ArgumentList '${escapePowerShellSingleQuoted(argumentList)}'`,
      "  -PassThru;",
      `$completed = $process.WaitForExit(${WINDOWS_INSTALL_TIMEOUT_MS});`,
      "if (-not $completed) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; throw 'TritonAI Harness installer timed out.' };",
      "$process.WaitForExit();",
      'Write-Output "TRITONAI_INSTALLER_EXIT_CODE=$($process.ExitCode)"'
    ].join(" "), emit, { env, timeoutMs: WINDOWS_INSTALL_TIMEOUT_MS + 30_000 });
  } catch (powershellError) {
    if (!isPermissionError(powershellError)) {
      throw powershellError;
    }
    throw new Error(
      `Windows blocked both safe ${TRITONAI_APP_DISPLAY_NAME} installer launch paths. `
      + "The Installer will not fall through to cmd.exe because it cannot reliably own and terminate the nested NSIS process.",
      { cause: powershellError }
    );
  }

  const exitCodeMatch = /(?:^|\r?\n)TRITONAI_INSTALLER_EXIT_CODE=(-?\d+)(?:\r?\n|$)/.exec(powerShellOutput);
  if (!exitCodeMatch) {
    throw new Error(
      `PowerShell launched the ${TRITONAI_APP_DISPLAY_NAME} installer but did not report an exit code; `
      + "not retrying to avoid running the installer twice."
    );
  }

  const exitCode = Number.parseInt(exitCodeMatch[1], 10);
  if (exitCode !== 0) {
    throw new Error(`${TRITONAI_APP_DISPLAY_NAME} installer exited with code ${exitCode}`);
  }
}

async function readWindowsAppVersion(appPath, emit) {
  const output = await runPowerShellCapture(
    `[Diagnostics.FileVersionInfo]::GetVersionInfo('${escapePowerShellSingleQuoted(appPath)}').ProductVersion`,
    emit
  );
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || null;
}

async function verifyExpectedWindowsHarnessPublisher(
  executablePath,
  emit,
  commandRuntime: WindowsInstallerCommandRuntime = {}
) {
  const platform = commandRuntime.platform || process.platform;
  if (platform !== "win32") {
    throw new Error("TritonAI Harness Authenticode verification must run on Windows.");
  }
  const capture = commandRuntime.runPowerShellCapture || runPowerShellCapture;
  const environment = {
    ...process.env,
    TRITONAI_HARNESS_SIGNATURE_PATH: executablePath,
    TRITONAI_HARNESS_EXPECTED_PUBLISHER: EXPECTED_WINDOWS_PUBLISHER_NAME
  };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [Environment]::GetEnvironmentVariable('TRITONAI_HARNESS_SIGNATURE_PATH', 'Process')",
    "$expected = [Environment]::GetEnvironmentVariable('TRITONAI_HARNESS_EXPECTED_PUBLISHER', 'Process')",
    "$signature = Get-AuthenticodeSignature -LiteralPath $target",
    "$publisher = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }",
    "[PSCustomObject]@{ status = [string]$signature.Status; publisher = $publisher; thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { '' }; timestamp = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { '' }; expected = $expected } | ConvertTo-Json -Compress"
  ].join("; ");
  const output = await capture(script, emit, { env: environment });
  const jsonLine = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
  let result;
  try {
    result = JSON.parse(jsonLine || "");
  } catch (error) {
    throw new Error(`Could not read ${TRITONAI_APP_DISPLAY_NAME} Authenticode verification output.`, { cause: error });
  }
  if (
    result.status !== "Valid" ||
    result.publisher !== EXPECTED_WINDOWS_PUBLISHER_NAME ||
    result.expected !== EXPECTED_WINDOWS_PUBLISHER_NAME ||
    !result.thumbprint ||
    !result.timestamp
  ) {
    throw new Error(
      `${TRITONAI_APP_DISPLAY_NAME} publisher verification failed for ${path.basename(executablePath)}; `
      + `expected '${EXPECTED_WINDOWS_PUBLISHER_NAME}', found '${result.publisher || "no signer"}' (${result.status || "unknown"}).`
    );
  }
  emit(`Verified ${TRITONAI_APP_DISPLAY_NAME} Windows publisher for ${path.basename(executablePath)}.`);
  return result;
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
      const policyPath = path.join(vendorDir, WINDOWS_ARTIFACT_TRUST_FILE);
      if (!fs.existsSync(policyPath)) {
        throw new Error(
          `Bundled ${TRITONAI_APP_DISPLAY_NAME} Windows installer is missing ${WINDOWS_ARTIFACT_TRUST_FILE}; `
          + "the release must declare whether Authenticode verification is required."
        );
      }
      const trustPolicy = readWindowsArtifactTrustPolicy(policyPath, {
        version: manifest.version,
        artifact: {
          fileName: selected.fileName,
          size: selected.expected.size,
          sha512: selected.expected.sha512
        }
      });
      return { manifestPath, installerPath, policyPath, trustPolicy, version: manifest.version, ...selected };
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
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version || "")) {
    throw new Error("TritonAI Harness manifest must declare a stable semantic version.");
  }
  const fileName = Object.keys(manifest.files || {}).find((entry) => pattern.test(entry));
  if (!fileName) {
    throw new Error(`${TRITONAI_APP_DISPLAY_NAME} manifest does not include an asset matching ${pattern}`);
  }

  const expected = manifest.files[fileName];
  if (/[\\/:]/.test(fileName) || !Number.isSafeInteger(expected.size) || expected.size <= 0
    || typeof expected.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(expected.sha512)) {
    throw new Error("TritonAI Harness manifest contains an unsafe asset name or invalid checksum metadata.");
  }
  return { fileName, expected };
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
      if (Object.prototype.hasOwnProperty.call(result.files, currentFile) || currentFile === "__proto__") {
        throw new Error("TritonAI Harness manifest contains a duplicate or unsafe asset name.");
      }
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

  const actual = fileDigest(file, "sha512", "base64");
  if (actual !== expected.sha512) {
    throw new Error(`SHA-512 mismatch for ${path.basename(file)}`);
  }
}

async function download(url, target, emit) {
  return downloadFileAtomic(url, target, emit, {
    totalTimeoutMs: RELEASE_DOWNLOAD_TOTAL_TIMEOUT_MS
  });
}

async function downloadText(url, emit) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-release-manifest-"));
  const target = path.join(tempDir, "manifest.yml");
  try {
    await downloadFileAtomic(url, target, emit, {
      totalTimeoutMs: RELEASE_DOWNLOAD_TOTAL_TIMEOUT_MS,
      maxBytes: RELEASE_MANIFEST_MAX_BYTES
    });
    return fs.readFileSync(target, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function unblockWindowsFile(file, emit) {
  if (process.platform !== "win32") return;

  await runPowerShell(`Unblock-File -LiteralPath '${escapePowerShellSingleQuoted(file)}'`, emit, { allowFailure: true });
}

function run(command, args, emit, options: CommandOptions = {}) {
  return new Promise<void>((resolve, reject) => {
    emit(`$ ${command} ${args.join(" ")}`);
    const platform = options.platform || process.platform;
    const terminate = options.terminate || terminateProcessTree;
    const child = spawn(command, args, {
      env: options.env || process.env,
      shell: resolveCommandShell(command, platform, options),
      detached: platform !== "win32"
    });
    let settled = false;
    let timingOut = false;
    const timeoutMs = options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled || timingOut) return;
      timingOut = true;
      void terminate(child, { platform }).then(() => {
        const error = Object.assign(
          new Error(`${command} timed out after ${timeoutMs}ms and its process tree was terminated`),
          { code: "ETIMEDOUT" }
        );
        if (options.allowFailure) {
          emit(`${error.message}; continuing.`);
          settle(resolve);
        } else {
          settle(() => reject(error));
        }
      }, (terminationError) => {
        settle(() => reject(Object.assign(new Error(
          `${command} timed out after ${timeoutMs}ms and termination could not be confirmed: ${terminationError.message}`,
          { cause: terminationError }
        ), { code: "ETERMINATE" })));
      });
    }, timeoutMs);
    const settle = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      callback();
      return true;
    };
    child.stdout.on("data", (chunk) => emit(clean(chunk)));
    child.stderr.on("data", (chunk) => emit(clean(chunk)));
    child.on("error", (error) => {
      if (settled || timingOut) return;
      if (options.allowFailure) {
        emit(`${command} failed: ${error.message}`);
        settle(resolve);
      } else {
        settle(() => reject(error));
      }
    });
    child.on("close", (code) => {
      if (settled || timingOut) return;
      if (code === 0 || options.allowFailure) {
        if (code !== 0) emit(`${command} exited with ${code}; continuing.`);
        settle(resolve);
      } else {
        settle(() => reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`)));
      }
    });
  });
}

function runCapture(command, args, emit, options: CommandOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    emit(`$ ${command} ${args.join(" ")}`);
    let stdout = "";
    let stderr = "";
    const platform = options.platform || process.platform;
    const terminate = options.terminate || terminateProcessTree;
    const child = spawn(command, args, {
      env: options.env || process.env,
      shell: resolveCommandShell(command, platform, options),
      detached: platform !== "win32"
    });
    let settled = false;
    let timingOut = false;
    const timeoutMs = options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled || timingOut) return;
      timingOut = true;
      void terminate(child, { platform }).then(() => {
        settle(() => reject(Object.assign(
          new Error(`${command} timed out after ${timeoutMs}ms and its process tree was terminated`),
          { code: "ETIMEDOUT" }
        )));
      }, (terminationError) => {
        settle(() => reject(Object.assign(new Error(
          `${command} timed out after ${timeoutMs}ms and termination could not be confirmed: ${terminationError.message}`,
          { cause: terminationError }
        ), { code: "ETERMINATE" })));
      });
    }, timeoutMs);
    const settle = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      callback();
      return true;
    };
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
    child.on("error", (error) => {
      if (settled || timingOut) return;
      settle(() => reject(error));
    });
    child.on("close", (code) => {
      if (settled || timingOut) return;
      if (code === 0) {
        settle(() => resolve(stdout));
      } else {
        settle(() => reject(new Error(`${command} ${args.join(" ")} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
      }
    });
  });
}

function resolveCommandShell(command, platform, options: CommandOptions = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "shell")) return options.shell;
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
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
    || /EPERM|EACCES|permission denied|access is denied/i.test(error && error.message);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  verifyExpectedMacHarnessPublisher,
  installMacApp,
  removeLegacyMacInstall,
  canCreateEntriesIn,
  getBundledMacDmg,
  getBundledWindowsInstaller,
  parseLatestYml,
  selectMacDmg,
  selectWindowsInstaller,
  buildWindowsEnvironmentScript,
  buildWindowsDesktopShortcutScript,
  findWindowsT3CodeApp,
  normalizeWindowsAppVersion,
  verifyExpectedWindowsHarnessPublisher,
  getLegacyMacAppPath,
  cleanupStaleWindowsUpgradeBackup,
  resolveCommandShell,
  runWindowsInstaller,
  runDesktopCommand: run,
  runDesktopCommandCapture: runCapture,
  writeWindowsLauncherScript
};
