const fs = require("fs");
const path = require("path");

const {
  NODE_VENDOR_SCHEMA_VERSION,
  NODE_VERSION,
  checksumForArchive,
  downloadFileAtomic,
  getNodeDistribution,
  verifyArchive
} = require("../src/installer/prerequisites");

const root = path.resolve(__dirname, "..", "..");
const targets = {
  "mac-arm64": { platform: "darwin", arch: "arm64" },
  "win-x64": { platform: "win32", arch: "x64" }
};

async function main() {
  const requested = process.argv[2] || (process.platform === "darwin" ? "mac-arm64" : "win-x64");
  const selected = requested === "all" ? Object.keys(targets) : [requested];
  for (const target of selected) await prepareNodeRuntimeVendor(target);
}

async function prepareNodeRuntimeVendor(targetName) {
  const target = targets[targetName];
  if (!target) throw new Error(`Unsupported Node.js runtime vendor target: ${targetName}`);

  const distribution = getNodeDistribution(target.platform, target.arch);
  const vendorParent = path.join(root, "vendor", "node-runtime");
  const vendorDir = path.join(vendorParent, targetName);
  fs.mkdirSync(vendorParent, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(vendorParent, `.node-runtime-${targetName}-stage-`));
  const shasumsPath = path.join(stageDir, `SHASUMS256-v${NODE_VERSION}.txt`);
  const archivePath = path.join(stageDir, distribution.archiveName);

  try {
    await downloadFileAtomic(distribution.shasumsUrl, shasumsPath, console.log);
    const sha256 = checksumForArchive(shasumsPath, distribution.archiveName);
    await downloadFileAtomic(distribution.archiveUrl, archivePath, console.log);
    verifyArchive(archivePath, { sha256 });
    const size = fs.statSync(archivePath).size;
    fs.rmSync(shasumsPath, { force: true });
    fs.writeFileSync(path.join(stageDir, "manifest.json"), `${JSON.stringify({
      schemaVersion: NODE_VENDOR_SCHEMA_VERSION,
      name: "node",
      version: NODE_VERSION,
      target: targetName,
      archive: {
        name: distribution.archiveName,
        size,
        sha256
      }
    }, null, 2)}\n`);
    activateStagedVendor(stageDir, vendorDir);
    console.log(`Prepared ${path.relative(root, vendorDir)} (${size} bytes)`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function activateStagedVendor(stageDir, vendorDir) {
  const backupRoot = fs.mkdtempSync(path.join(path.dirname(vendorDir), ".node-runtime-backup-"));
  const previous = path.join(backupRoot, "previous");
  let previousMoved = false;
  let activated = false;
  try {
    if (fs.existsSync(vendorDir)) {
      fs.renameSync(vendorDir, previous);
      previousMoved = true;
    }
    fs.renameSync(stageDir, vendorDir);
    activated = true;
  } catch (error) {
    if (previousMoved && !fs.existsSync(vendorDir)) {
      fs.renameSync(previous, vendorDir);
      previousMoved = false;
    }
    throw error;
  } finally {
    if (activated || !previousMoved) fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { prepareNodeRuntimeVendor, targets };
