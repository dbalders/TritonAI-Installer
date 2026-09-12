import { fileDigest } from "../src/installer/file-digest";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const { measureSync } = require(path.join(root, "scripts", "local-release-timing.cjs"));
const pkg = require(path.join(root, "package.json"));
const outputDir = path.join(root, "artifacts", "macos-release");
const configPath = path.join(root, "electron-builder.mac.json");
const builderCli = path.join(root, "node_modules", "electron-builder", "cli.js");
const appPath = path.join(outputDir, "mac-arm64", "TritonAI Installer.app");
const dmgVolumeName = "Double-click TritonAI Installer";
const dmgPath = path.join(outputDir, `TritonAI-Installer-${pkg.version}-arm64.dmg`);

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
  process.env.TRITONAI_RELEASE_TIMING_FILE ||= path.join(outputDir, "timings.jsonl");
  process.env.TRITONAI_RELEASE_TIMING_STAGE ||= "installer-mac";
  fs.rmSync(path.join(root, "artifacts", "SHA256SUMS.txt"), { force: true });
  measureSync("Prepare managed configuration", prepareManagedConfig);
  measureSync("Prepare bundled artifacts", prepareVendorArtifacts);

  measureSync("Package, sign and notarize Installer app", () => run(process.execPath, [
    builderCli,
    "--mac",
    "--arm64",
    "--dir",
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
  }));

  run(process.execPath, [path.join(root, "dist", "scripts", "verify-macos-bundled-resources.js"), appPath]);
  measureSync("Verify packaged Installer app", () => verifyApp(appPath));
  measureSync("Create Installer DMG", createDmgFromApp);
  measureSync("Sign Installer DMG", () => signDmgs(identity));
  measureSync("Notarize and verify final Installer DMG", () => notarizeAndStapleDmgs(notary));

  console.log(`macOS release artifacts ready: ${path.relative(root, outputDir)}`);
  console.log("Build Windows artifacts, then run npm run release:contract for the combined checksum manifest.");
}

function prepareVendorArtifacts() {
  run(process.execPath, [
    path.join(root, "dist", "scripts", "prepare-plugins-vendor.js"),
    "--production"
  ]);
  run(process.execPath, [path.join(root, "dist", "scripts", "prepare-t3code-desktop-vendor.js")]);
  run(process.execPath, [path.join(root, "dist", "scripts", "prepare-codex-cli-vendor.js"), "mac-arm64"]);
  run(process.execPath, [path.join(root, "dist", "scripts", "prepare-node-runtime-vendor.js"), "mac-arm64"]);
  run(process.execPath, [path.join(root, "dist", "scripts", "prepare-skills-vendor.js"), "--require-clean"]);
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

function createDmgFromApp({ sourceApp = appPath, targetDmg = dmgPath, runCommand = run } = {}) {
  if (!fs.existsSync(sourceApp) || !fs.lstatSync(sourceApp).isDirectory()) {
    throw new Error(`Missing assembled macOS Installer app: ${sourceApp}`);
  }
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-installer-dmg-src-"));
  const sourceRoot = path.join(stagingDir, "source");
  const writableDmg = path.join(stagingDir, "installer-writable.dmg");
  const mountPoint = path.join(stagingDir, "mount");
  const compressedDmg = path.join(stagingDir, "installer-compressed.dmg");
  let mounted = false;
  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    runCommand("/usr/bin/ditto", [
      "--noextattr",
      "--noqtn",
      sourceApp,
      path.join(sourceRoot, path.basename(sourceApp))
    ]);
    fs.mkdirSync(mountPoint, { recursive: true });
    runCommand("/usr/bin/hdiutil", [
      "create",
      "-size",
      `${diskImageCapacityMib(sourceRoot)}m`,
      "-fs",
      "HFS+",
      "-volname",
      dmgVolumeName,
      "-ov",
      writableDmg
    ]);
    runCommand("/usr/bin/hdiutil", [
      "attach",
      writableDmg,
      "-nobrowse",
      "-noverify",
      "-noautoopen",
      "-mountpoint",
      mountPoint
    ]);
    mounted = true;
    runCommand("/usr/bin/ditto", [
      "--noextattr",
      "--noqtn",
      sourceRoot,
      mountPoint
    ]);
    runCommand("/usr/bin/hdiutil", ["detach", mountPoint]);
    mounted = false;
    runCommand("/usr/bin/hdiutil", [
      "convert",
      writableDmg,
      "-format",
      "UDZO",
      "-o",
      compressedDmg
    ]);
    fs.rmSync(targetDmg, { force: true });
    fs.renameSync(compressedDmg, targetDmg);
    return targetDmg;
  } finally {
    if (mounted) {
      try {
        runCommand("/usr/bin/hdiutil", ["detach", mountPoint, "-force"]);
      } catch {
        // Preserve the original packaging failure while still attempting cleanup.
      }
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function diskImageCapacityMib(sourceRoot) {
  const allocationBlockBytes = 4 * 1024;
  const stack = [sourceRoot];
  let allocatedBytes = 0;
  while (stack.length > 0) {
    const entryPath = stack.pop();
    const stat = fs.lstatSync(entryPath);
    if (stat.isDirectory()) {
      allocatedBytes += allocationBlockBytes;
      for (const entry of fs.readdirSync(entryPath)) stack.push(path.join(entryPath, entry));
      continue;
    }
    const diskBytes = Number.isFinite(stat.blocks) ? stat.blocks * 512 : 0;
    allocatedBytes += Math.max(allocationBlockBytes, stat.size, diskBytes);
  }
  const capacityBytes = Math.ceil(allocatedBytes * 1.2) + 64 * 1024 * 1024;
  return Math.ceil(capacityBytes / (1024 * 1024));
}

function notarizeAndStapleDmgs(notary) {
  const candidates = [];
  for (const dmg of releaseFiles(".dmg")) {
    notarizeDmg(dmg, notary);
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg]);
    run("hdiutil", ["verify", dmg]);
    candidates.push(verifyMountedDmgApp(dmg));
  }
  if (candidates.length !== 1) throw new Error(`Expected exactly one macOS Installer DMG; found ${candidates.length}.`);
  writePackagedBootProof(candidates);
}

function notarizeDmg(dmg, notary, {
  execute = spawnSync,
  sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  log = console.log
} = {}) {
  const digest = sha256(dmg);
  const auth = ["--key", notary.appleApiKey, "--key-id", notary.appleApiKeyId, "--issuer", notary.appleApiIssuer];
  const invoke = (args, timeout) => measureSync(args[0] === "submit" ? "Upload Installer DMG to Apple" : "Wait for Apple DMG notarization", () => execute("xcrun", ["notarytool", ...args, ...auth, "--output-format", "json"], {
    cwd: root, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 1024 * 1024
  }));
  const receipt = (result) => {
    try { return JSON.parse(result.stdout || ""); } catch { return null; }
  };
  // Upload once. A wait timeout does not cancel Apple's processing, so every
  // subsequent request must use this ID instead of uploading the DMG again.
  const submitted = invoke(["submit", dmg, "--no-wait"], 10 * 60_000);
  const id = receipt(submitted)?.id;
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error("Apple notarization did not return a submission ID; no automatic re-upload was attempted.");
  }
  log(`Apple notarization submission: ${id}; SHA256: ${digest}`);
  if (submitted.error || submitted.status !== 0) {
    throw new Error(`Apple notarization upload did not complete successfully for submission ${id}; no automatic re-upload was attempted.`);
  }
  for (let attempt = 1; attempt <= 6; attempt++) {
    const result = invoke(["wait", id, "--timeout", "120s"], 150_000);
    const info = receipt(result);
    if (info?.id && info.id !== id) throw new Error(`Apple notarization returned a different submission ID for ${id}.`);
    if (info?.status === "Invalid" || info?.status === "Rejected") {
      throw new Error(`Apple notarization rejected submission ${id}.`);
    }
    if (!result.error && result.status === 0 && info?.id === id && info.status === "Accepted") {
      if (sha256(dmg) !== digest) throw new Error(`DMG changed after notarization submission ${id}.`);
      return { id, status: "Accepted", sha256: digest };
    }
    const timedOut = result.error?.code === "ETIMEDOUT";
    const transient = timedOut
      || /NSURLErrorDomain[^\n]*Code=-100[134569]\b|\b(?:timed out|timeout|connection reset|network connection|HTTP (?:429|5\d\d))\b/i.test(result.stderr || "");
    if ((result.signal && !timedOut) || (info?.status && info.status !== "In Progress" && info.status !== "Accepted")
      || (!transient && !(info?.id === id && info.status === "In Progress"))) {
      throw new Error(`Could not verify Apple notarization submission ${id}; no automatic re-upload was attempted.`);
    }
    if (attempt < 6) {
      log(`Apple notarization status unavailable or still processing; retrying submission ${id} (${attempt}/6).`);
      sleep(5_000);
    }
  }
  throw new Error(`Apple notarization status retry limit reached for submission ${id}; no automatic re-upload was attempted.`);
}

function verifyMountedDmgApp(dmg) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-installer-dmg-"));
  try {
    run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    const mountedApp = path.join(mountPoint, "TritonAI Installer.app");
    verifyApp(mountedApp);
    const marker = measureSync("Boot final mounted Installer", () => runPackagedBootSmoke(mountedApp));
    return {
      id: "macos-dmg",
      path: path.relative(root, dmg).split(path.sep).join("/"),
      sha256: sha256(dmg),
      marker
    };
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function runPackagedBootSmoke(mountedApp) {
  const markerPath = path.join(os.tmpdir(), `tritonai-installer-smoke-macos-${process.pid}-${Date.now()}.json`);
  const userDataPath = `${markerPath}.userdata`;
  const executable = path.join(mountedApp, "Contents", "MacOS", "TritonAI Installer");
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...nativeEnvironment } = process.env;
  try {
    const result = spawnSync(executable, [], {
      cwd: root,
      env: {
        ...nativeEnvironment,
        TRITONAI_INSTALLER_SMOKE_MARKER: markerPath
      },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Packaged macOS Installer failed its native boot gate: ${result.error?.message || result.stderr || `exit ${result.status}`}`
      );
    }
    if (!fs.existsSync(markerPath)) throw new Error("Packaged macOS Installer did not write its readiness marker.");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (
      marker.schemaVersion !== 1 ||
      marker.productName !== "TritonAI Installer" ||
      marker.version !== pkg.version ||
      marker.platform !== "darwin" ||
      marker.arch !== "arm64" ||
      marker.packaged !== true ||
      !Number.isInteger(marker.healthyForMs) ||
      marker.healthyForMs < 5_000 ||
      !marker.readyAt
    ) {
      throw new Error("Packaged macOS Installer returned an invalid readiness marker.");
    }
    return marker;
  } finally {
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

function writePackagedBootProof(candidates) {
  const proofPath = path.join(outputDir, "packaged-boot.json");
  const temporaryPath = `${proofPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({
    schemaVersion: 1,
    version: pkg.version,
    platform: "macos-arm64",
    verifiedAt: new Date().toISOString(),
    candidates
  }, null, 2)}\n`);
  fs.renameSync(temporaryPath, proofPath);
}

function sha256(file) {
  return fileDigest(file, "sha256", "hex");
}

function releaseFiles(...extensions) {
  if (!fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir)
    .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
    .map((entry) => path.join(outputDir, entry))
    .sort();
}

function run(command, args, env = process.env) {
  return measureSync(path.basename(command) === "node" ? path.basename(args[0]) : path.basename(command), () => {
    const result = spawnSync(command, args, {
      cwd: root,
      env,
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} failed with exit code ${result.status}`);
    }
  });
}

if (require.main === module) main();

module.exports = { createDmgFromApp, notarizeDmg };
