const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const defaultReleaseBase = process.env.UCSD_HARNESS_RELEASE_BASE
  || process.env.UCSD_T3CODE_RELEASE_BASE
  || "https://github.com/dbalders/TritonAI-Harness/releases/latest/download";
const macReleaseBase = process.env.UCSD_HARNESS_MAC_RELEASE_BASE
  || process.env.UCSD_T3CODE_MAC_RELEASE_BASE
  || defaultReleaseBase;
const winReleaseBase = process.env.UCSD_HARNESS_WIN_RELEASE_BASE
  || process.env.UCSD_T3CODE_WIN_RELEASE_BASE
  || defaultReleaseBase;
const macManifestFile = "latest-mac.yml";
const winManifestFile = "latest.yml";
const desktopAssetPrefixPattern = "TritonAI-Harness";

function main() {
  const target = process.argv[2] || process.env.UCSD_T3CODE_VENDOR_TARGET || defaultTarget();

  if (target === "mac-arm64") {
    prepareMacVendor("arm64");
    return;
  }

  if (target === "win-x64") {
    prepareWindowsVendor("x64");
    return;
  }

  if (target === "all") {
    prepareMacVendor("arm64");
    prepareWindowsVendor("x64");
    return;
  }

  throw new Error(`Unsupported TritonAI Harness vendor target: ${target}`);
}

function defaultTarget() {
  return process.platform === "darwin" ? "mac-arm64" : "win-x64";
}

function prepareMacVendor(arch) {
  const vendorDir = path.join(root, "vendor", "t3code-desktop", `mac-${arch}`);
  const manifestPath = path.join(vendorDir, macManifestFile);
  fs.mkdirSync(vendorDir, { recursive: true });
  downloadManifest(`${macReleaseBase}/${macManifestFile}`, manifestPath);

  const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
  const selected = selectManifestFile(manifest, new RegExp(`-${arch}\\.dmg$`));
  const dmgPath = path.join(vendorDir, selected.fileName);
  downloadVerified(`${macReleaseBase}/${selected.fileName}`, dmgPath, selected.expected);
  verifyDmgContainsApp(dmgPath);
  removeMatchingFiles(vendorDir, /\.(?:dmg|zip|blockmap)$/i, new Set([selected.fileName]));
  console.log(`Prepared ${path.relative(root, dmgPath)}`);
}

function prepareWindowsVendor(arch) {
  const vendorDir = path.join(root, "vendor", "t3code-desktop", `win-${arch}`);
  const manifestPath = path.join(vendorDir, winManifestFile);
  fs.mkdirSync(vendorDir, { recursive: true });
  downloadManifest(`${winReleaseBase}/${winManifestFile}`, manifestPath);

  const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
  const selected = selectManifestFile(manifest, new RegExp(`-${arch}\\.exe$`));
  const installerPath = path.join(vendorDir, selected.fileName);
  downloadVerified(`${winReleaseBase}/${selected.fileName}`, installerPath, selected.expected);
  removeMatchingFiles(vendorDir, /\.(?:exe|blockmap)$/i, new Set([selected.fileName]));
  console.log(`Prepared ${path.relative(root, installerPath)}`);
}

function downloadVerified(url, target, expected) {
  const valid = fs.existsSync(target)
    && fs.statSync(target).size === expected.size
    && sha512Base64(target) === expected.sha512;

  if (valid) {
    console.log(`Using cached ${path.basename(target)}`);
    return;
  }

  const temp = tempDownloadPath(target);
  fs.rmSync(temp, { force: true });
  downloadFresh(url, temp);

  if (fs.statSync(temp).size !== expected.size) {
    fs.rmSync(temp, { force: true });
    throw new Error(`Size mismatch for ${path.basename(target)}`);
  }
  if (sha512Base64(temp) !== expected.sha512) {
    fs.rmSync(temp, { force: true });
    throw new Error(`SHA-512 mismatch for ${path.basename(target)}`);
  }

  fs.renameSync(temp, target);
}

function removeMatchingFiles(dir, pattern, keep = new Set()) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (keep.has(entry)) continue;
    if (pattern.test(entry)) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

function downloadManifest(url, target) {
  const temp = tempDownloadPath(target);
  fs.rmSync(temp, { force: true });

  try {
    downloadFresh(url, temp);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function downloadFresh(url, target) {
  console.log(`Downloading ${url}...`);
  const temp = tempDownloadPath(target);
  fs.rmSync(temp, { force: true });

  execFileSync("curl", [
    "-fL",
    "--connect-timeout",
    "15",
    "--max-time",
    "600",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    url,
    "-o",
    temp
  ], { stdio: "inherit" });
  fs.renameSync(temp, target);
}

function tempDownloadPath(target) {
  return path.join(os.tmpdir(), `${path.basename(target)}.${process.pid}.tmp`);
}

function verifyDmgContainsApp(file) {
  if (process.platform !== "darwin") return;

  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-desktop-vendor-"));
  try {
    run("hdiutil", ["attach", file, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    if (!findApp(mountPoint)) {
      throw new Error(`Downloaded TritonAI Harness image does not contain an app bundle: ${file}`);
    }
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function findApp(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const direct = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (direct) return path.join(rootDir, direct.name);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findApp(path.join(rootDir, entry.name));
    if (nested) return nested;
  }

  return null;
}

function selectManifestFile(manifest, pattern) {
  const fileName = Object.keys(manifest.files || {}).find((entry) => pattern.test(entry));
  if (!fileName) {
    throw new Error(`TritonAI Harness manifest does not include an asset matching ${pattern}`);
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

function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

main();
