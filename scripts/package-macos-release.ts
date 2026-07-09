const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const outputDir = path.join(root, "artifacts", "macos-release");
const configPath = path.join(root, "electron-builder.mac.json");
const builderCli = path.join(root, "node_modules", "electron-builder", "cli.js");
const appPath = path.join(outputDir, "mac-arm64", "TritonAI Installer.app");
const dmgVolumeName = "Double-click to Install";
const dmgBackgroundSource = path.join(root, "build", "dmg-background.png");
const dmgBackgroundMountPath = path.join(".background", "dmg-background.png");
const dmgVolumeIconSource = path.join(root, "build", "icon.icns");
const dmgVolumeIconMountPath = ".VolumeIcon.icns";
const dmgWindowBounds = [680, 220, 1240, 560];
const dmgAppIconPosition = [280, 150];
const dmgIconSize = 152;

function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS release packaging must run on macOS.");
  }

  const identity = findDeveloperIdIdentity();
  if (!identity) {
    throw new Error([
      "Missing Developer ID Application signing identity.",
      "Run npm run mac:prepare-developer-id-csr, create the Developer ID Application cert in Apple Developer,",
      "then run npm run mac:import-developer-id-cert -- /path/to/downloaded.cer."
    ].join("\n"));
  }

  const notary = getNotaryEnv();
  fs.rmSync(outputDir, { recursive: true, force: true });
  prepareManagedConfig();
  prepareVendorArtifacts();

  run(process.execPath, [
    builderCli,
    "--mac",
    "--arm64",
    "--config",
    configPath,
    "--publish",
    "never"
  ], {
    ...process.env,
    CSC_NAME: identity,
    APPLE_API_KEY: notary.appleApiKey,
    APPLE_API_KEY_ID: notary.appleApiKeyId,
    APPLE_API_ISSUER: notary.appleApiIssuer
  });

  run(process.execPath, [path.join(root, "dist", "scripts", "verify-macos-bundled-resources.js"), appPath]);
  verifyApp(appPath);
  recreateDmgsFromApp();
  signDmgs(identity);
  notarizeAndStapleDmgs(notary);
  writeChecksums();

  console.log(`macOS release artifacts ready: ${path.relative(root, outputDir)}`);
}

function prepareVendorArtifacts() {
  run(process.execPath, [path.join(root, "dist", "scripts", "prepare-t3code-desktop-vendor.js")]);
  run(process.execPath, [path.join(root, "dist", "scripts", "prepare-codex-cli-vendor.js"), "mac-arm64"]);
  run(process.execPath, [path.join(root, "dist", "scripts", "prepare-skills-vendor.js")]);
}

function prepareManagedConfig() {
  run(process.execPath, [path.join(root, "dist", "scripts", "write-managed-config.js")]);
}

function findDeveloperIdIdentity() {
  if (process.env.DEVELOPER_ID_APPLICATION) {
    return process.env.DEVELOPER_ID_APPLICATION;
  }

  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  const line = result.stdout
    .split(/\r?\n/)
    .find((entry) => entry.includes('"Developer ID Application:'));
  const match = line && line.match(/"([^"]+)"/);
  return match ? match[1].replace(/^Developer ID Application:\s*/, "") : null;
}

function getNotaryEnv() {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  const fromEnv = {
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER
  };
  if (fromEnv.appleApiKey && fromEnv.appleApiKeyId && fromEnv.appleApiIssuer) {
    return fromEnv;
  }

  const localConfig = path.join(os.homedir(), ".agents", "secrets", "appstore", "config.json");
  if (!fs.existsSync(localConfig)) {
    throw new Error("Missing notarization config. Set APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER.");
  }

  const config = JSON.parse(fs.readFileSync(localConfig, "utf8"));
  const keyPath = path.resolve(path.dirname(localConfig), config.keyFile);
  if (!config.keyId || !config.issuerId || !fs.existsSync(keyPath)) {
    throw new Error(`Invalid notarization config: ${localConfig}`);
  }

  return {
    appleApiKey: keyPath,
    appleApiKeyId: config.keyId,
    appleApiIssuer: config.issuerId
  };
}

function verifyApp(target) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", target]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", target]);
}

function signDmgs(identity) {
  for (const dmg of releaseFiles(".dmg")) {
    run("codesign", ["--force", "--sign", identity, "--timestamp", dmg]);
  }
}

function recreateDmgsFromApp() {
  const dmgs = releaseFiles(".dmg");
  if (dmgs.length === 0) {
    throw new Error(`No DMG artifacts found under ${outputDir}`);
  }

  for (const dmg of dmgs) {
    recreateDmgFromApp(dmg);
  }
}

function recreateDmgFromApp(dmg) {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-installer-dmg-src-"));
  const mountPoint = path.join(stagingDir, "mount");
  const writableDmg = path.join(stagingDir, "installer-rw.dmg");
  const sizeMb = Math.max(1024, Math.ceil(directorySizeBytes(appPath) / 1024 / 1024) + 256);
  let mounted = false;
  try {
    fs.mkdirSync(mountPoint, { recursive: true });
    fs.rmSync(dmg, { force: true });
    run("hdiutil", [
      "create",
      "-size",
      `${sizeMb}m`,
      "-fs",
      "HFS+",
      "-volname",
      dmgVolumeName,
      "-ov",
      writableDmg
    ]);
    run("hdiutil", ["attach", writableDmg, "-nobrowse", "-mountpoint", mountPoint]);
    mounted = true;
    run("ditto", [appPath, path.join(mountPoint, path.basename(appPath))]);
    installDmgBackground(mountPoint);
    installDmgVolumeIcon(mountPoint);
    applyDmgFinderLayout(mountPoint);
    run("hdiutil", ["detach", mountPoint]);
    mounted = false;
    run("hdiutil", [
      "convert",
      writableDmg,
      "-format",
      "UDZO",
      "-o",
      dmg
    ]);
  } finally {
    if (mounted) {
      spawnSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" });
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function installDmgBackground(mountPoint) {
  if (!fs.existsSync(dmgBackgroundSource)) {
    throw new Error(`Missing DMG background asset: ${dmgBackgroundSource}`);
  }

  const backgroundTarget = path.join(mountPoint, dmgBackgroundMountPath);
  fs.mkdirSync(path.dirname(backgroundTarget), { recursive: true });
  fs.copyFileSync(dmgBackgroundSource, backgroundTarget);
}

function installDmgVolumeIcon(mountPoint) {
  if (!fs.existsSync(dmgVolumeIconSource)) {
    throw new Error(`Missing DMG volume icon asset: ${dmgVolumeIconSource}`);
  }

  fs.copyFileSync(dmgVolumeIconSource, path.join(mountPoint, dmgVolumeIconMountPath));
  run("SetFile", ["-a", "C", mountPoint]);
}

function applyDmgFinderLayout(mountPoint) {
  const appName = path.basename(appPath);
  const backgroundPath = path.join(mountPoint, dmgBackgroundMountPath);
  const finderScript = [
    'tell application "Finder"',
    `  set dmgRoot to POSIX file "${escapeAppleScriptString(mountPoint)}" as alias`,
    `  set backgroundImage to POSIX file "${escapeAppleScriptString(backgroundPath)}" as alias`,
    "  tell folder dmgRoot",
    "    open",
    "    set current view of container window to icon view",
    "    set toolbar visible of container window to false",
    "    set statusbar visible of container window to false",
    `    set bounds of container window to {${dmgWindowBounds.join(", ")}}`,
    "    set viewOptions to icon view options of container window",
    "    set arrangement of viewOptions to not arranged",
    `    set icon size of viewOptions to ${dmgIconSize}`,
    "    set background picture of viewOptions to backgroundImage",
    `    set position of item "${escapeAppleScriptString(appName)}" of container window to {${dmgAppIconPosition.join(", ")}}`,
    "    update without registering applications",
    "    close",
    "  end tell",
    "end tell"
  ];

  run("osascript", finderScript.flatMap((line) => ["-e", line]));
  run("sync", []);
}

function escapeAppleScriptString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function directorySizeBytes(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return stat.size;
  }

  return fs.readdirSync(target)
    .reduce((total, entry) => total + directorySizeBytes(path.join(target, entry)), stat.size);
}

function notarizeAndStapleDmgs(notary) {
  for (const dmg of releaseFiles(".dmg")) {
    run("xcrun", [
      "notarytool",
      "submit",
      dmg,
      "--key",
      notary.appleApiKey,
      "--key-id",
      notary.appleApiKeyId,
      "--issuer",
      notary.appleApiIssuer,
      "--wait"
    ]);
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg]);
    run("hdiutil", ["verify", dmg]);
    verifyMountedDmgApp(dmg);
  }
}

function verifyMountedDmgApp(dmg) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-installer-dmg-"));
  try {
    run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    const mountedApp = path.join(mountPoint, "TritonAI Installer.app");
    verifyApp(mountedApp);
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function writeChecksums() {
  const files = releaseFiles(".dmg");
  const sums = files
    .map((file) => {
      const result = spawnSync("shasum", ["-a", "256", file], { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    })
    .join("\n");
  fs.writeFileSync(path.join(outputDir, "SHA256SUMS.txt"), `${sums}\n`);
}

function releaseFiles(...extensions) {
  if (!fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir)
    .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
    .map((entry) => path.join(outputDir, entry))
    .sort();
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

main();
