const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const {
  expectedHarnessVersion,
  defaultReleaseBase,
  macReleaseBase,
  winReleaseBase
} = readHarnessSourceEnvironment(process.env);
const macManifestFile = "latest-mac.yml";
const winManifestFile = "latest.yml";

function readHarnessSourceEnvironment(env: NodeJS.ProcessEnv = {}) {
  const expectedVersion = env.TRITONAI_HARNESS_VERSION || "";
  const releaseBase = env.TRITONAI_HARNESS_RELEASE_BASE || "";
  return {
    expectedHarnessVersion: expectedVersion,
    defaultReleaseBase: releaseBase,
    macReleaseBase: env.TRITONAI_HARNESS_MAC_RELEASE_BASE || releaseBase,
    winReleaseBase: env.TRITONAI_HARNESS_WIN_RELEASE_BASE || releaseBase
  };
}

function main() {
  const target = process.argv[2] || process.env.TRITONAI_HARNESS_VENDOR_TARGET || defaultTarget();
  assertExplicitHarnessSource({ expectedVersion: expectedHarnessVersion, macReleaseBase, winReleaseBase, target });

  if (target === "mac-arm64") {
    prepareMacVendor("arm64");
    return;
  }

  if (target === "win-x64") {
    prepareWindowsVendor("x64");
    return;
  }

  if (target === "all") {
    prepareAllVendors();
    return;
  }

  throw new Error(`Unsupported TritonAI Harness vendor target: ${target}`);
}

function defaultTarget() {
  return process.platform === "darwin" ? "mac-arm64" : "win-x64";
}

function prepareMacVendor(arch) {
  const stage = stageMacVendor(arch);
  try {
    activateStagedVendors([stage]);
    console.log(`Prepared ${path.relative(root, path.join(stage.vendorDir, stage.assetName))}`);
  } finally {
    fs.rmSync(stage.stagingDir, { recursive: true, force: true });
  }
}

function stageMacVendor(arch) {
  const vendorDir = path.join(root, "vendor", "t3code-desktop", `mac-${arch}`);
  const stagingDir = createSiblingTempDir(vendorDir, ".harness-mac-vendor-");
  try {
    const manifestPath = path.join(stagingDir, macManifestFile);
    downloadManifest(`${macReleaseBase}/${macManifestFile}`, manifestPath);
    const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
    assertManifestVersion(manifest, expectedHarnessVersion, "macOS");
    const expectedName = `TritonAI-Harness-${expectedHarnessVersion}-${arch}.dmg`;
    const selected = selectManifestFile(manifest, new RegExp(`^${escapeRegExp(expectedName)}$`));
    const dmgPath = path.join(stagingDir, selected.fileName);
    downloadVerified(`${macReleaseBase}/${selected.fileName}`, dmgPath, selected.expected);
    verifyDmgContainsApp(dmgPath);
    return { stagingDir, vendorDir, version: manifest.version, assetName: selected.fileName };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function prepareWindowsVendor(arch) {
  const stage = stageWindowsVendor(arch);
  try {
    activateStagedVendors([stage]);
    console.log(`Prepared ${path.relative(root, path.join(stage.vendorDir, stage.assetName))}`);
  } finally {
    fs.rmSync(stage.stagingDir, { recursive: true, force: true });
  }
}

function stageWindowsVendor(arch) {
  const vendorDir = path.join(root, "vendor", "t3code-desktop", `win-${arch}`);
  const stagingDir = createSiblingTempDir(vendorDir, ".harness-win-vendor-");
  try {
    const manifestPath = path.join(stagingDir, winManifestFile);
    downloadManifest(`${winReleaseBase}/${winManifestFile}`, manifestPath);
    const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
    assertManifestVersion(manifest, expectedHarnessVersion, "Windows");
    const expectedName = `TritonAI-Harness-${expectedHarnessVersion}-${arch}.exe`;
    const selected = selectManifestFile(manifest, new RegExp(`^${escapeRegExp(expectedName)}$`));
    const installerPath = path.join(stagingDir, selected.fileName);
    downloadVerified(`${winReleaseBase}/${selected.fileName}`, installerPath, selected.expected);
    return { stagingDir, vendorDir, version: manifest.version, assetName: selected.fileName };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function prepareAllVendors() {
  const stages = [];
  try {
    stages.push(stageMacVendor("arm64"));
    stages.push(stageWindowsVendor("x64"));
    assertMatchingManifestVersions(stages.map((stage) => stage.version));
    activateStagedVendors(stages);
    for (const stage of stages) {
      console.log(`Prepared ${path.relative(root, path.join(stage.vendorDir, stage.assetName))}`);
    }
  } finally {
    for (const stage of stages) {
      fs.rmSync(stage.stagingDir, { recursive: true, force: true });
    }
  }
}

function assertExplicitHarnessSource({ expectedVersion, macReleaseBase, winReleaseBase, target }) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error("TRITONAI_HARNESS_VERSION must explicitly name the stable TritonAI Harness version to vendor.");
  }
  if (["mac-arm64", "all"].includes(target) && !macReleaseBase) {
    throw new Error("Set TRITONAI_HARNESS_RELEASE_BASE or TRITONAI_HARNESS_MAC_RELEASE_BASE explicitly.");
  }
  if (["win-x64", "all"].includes(target) && !winReleaseBase) {
    throw new Error("Set TRITONAI_HARNESS_RELEASE_BASE or TRITONAI_HARNESS_WIN_RELEASE_BASE explicitly.");
  }
}

function assertManifestVersion(manifest, expectedVersion, platformLabel) {
  if (manifest.version !== expectedVersion) {
    throw new Error(`${platformLabel} TritonAI Harness manifest version ${manifest.version || "missing"} does not match expected ${expectedVersion}.`);
  }
}

function assertMatchingManifestVersions(versions) {
  const unique = [...new Set(versions.filter(Boolean))];
  if (unique.length !== 1) {
    throw new Error(`macOS and Windows TritonAI Harness manifest versions must match; found ${unique.join(", ") || "none"}.`);
  }
}

function createSiblingTempDir(target, prefix) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function activateStagedVendors(stages) {
  const activated = [];
  let completed = false;
  try {
    for (const stage of stages) {
      const backupRoot = createSiblingTempDir(stage.vendorDir, ".harness-vendor-backup-");
      const previous = path.join(backupRoot, path.basename(stage.vendorDir));
      const record = { ...stage, backupRoot, previous, previousMoved: false };
      activated.push(record);
      if (fs.existsSync(stage.vendorDir)) {
        fs.renameSync(stage.vendorDir, previous);
        record.previousMoved = true;
      }
      fs.renameSync(stage.stagingDir, stage.vendorDir);
    }
    completed = true;
  } catch (error) {
    const rollbackErrors = [];
    for (const record of [...activated].reverse()) {
      fs.rmSync(record.vendorDir, { recursive: true, force: true });
      if (record.previousMoved) {
        try {
          fs.renameSync(record.previous, record.vendorDir);
          record.previousMoved = false;
        } catch (rollbackError) {
          rollbackErrors.push(`${record.vendorDir}: ${rollbackError.message}; backup kept at ${record.previous}`);
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${error.message} Vendor rollback failures: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  } finally {
    for (const record of activated) {
      if (completed || !record.previousMoved) {
        fs.rmSync(record.backupRoot, { recursive: true, force: true });
      }
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

if (require.main === module) {
  main();
}

module.exports = {
  activateStagedVendors,
  assertExplicitHarnessSource,
  assertMatchingManifestVersions,
  assertManifestVersion,
  parseLatestYml,
  readHarnessSourceEnvironment,
  selectManifestFile
};
