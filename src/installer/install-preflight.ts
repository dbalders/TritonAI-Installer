const fs = require("fs");
const path = require("path");

const GIB = 1024 ** 3;
const MINIMUM_FREE_BYTES = 3 * GIB;
const ROLLBACK_RESERVE_BYTES = 1 * GIB;
const PAYLOAD_EXPANSION_FACTOR = 3;

function checkInstallCapacity({
  paths,
  resourcesPath,
  appRoot,
  emit,
  statfs = fs.statfsSync,
  directorySize = getDirectorySize
}) {
  const targetPath = nearestExistingAncestor(paths.homeDir);
  let stats;
  try {
    stats = statfs(targetPath);
  } catch (error) {
    throw new Error(`Could not determine available disk space for ${targetPath}: ${error.message}`);
  }

  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error(`Could not determine available disk space for ${targetPath}: invalid filesystem capacity result.`);
  }

  const vendorRoots = uniqueExistingDirectories([
    resourcesPath && path.join(resourcesPath, "app", "vendor"),
    resourcesPath && path.join(resourcesPath, "vendor"),
    appRoot && path.join(appRoot, "vendor")
  ]);
  const bundledBytes = vendorRoots.reduce((total, root) => total + directorySize(root), 0);
  const requiredBytes = Math.max(
    MINIMUM_FREE_BYTES,
    (bundledBytes * PAYLOAD_EXPANSION_FACTOR) + ROLLBACK_RESERVE_BYTES
  );

  emit(
    `Disk preflight: ${formatGiB(availableBytes)} available; `
    + `${formatGiB(requiredBytes)} reserved for install, staging, and rollback.`
  );
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Not enough free disk space to install TritonAI Harness safely. `
      + `${formatGiB(requiredBytes)} is required, but only ${formatGiB(availableBytes)} is available at ${targetPath}. `
      + "Free space and run the installer again; no existing managed runtime or application files were changed."
    );
  }

  return { availableBytes, requiredBytes, bundledBytes, targetPath };
}

function getDirectorySize(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += getDirectorySize(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function uniqueExistingDirectories(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates.filter(Boolean)) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
    const canonical = fs.realpathSync(candidate);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

function formatGiB(bytes) {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

module.exports = {
  checkInstallCapacity,
  getDirectorySize,
  MINIMUM_FREE_BYTES,
  ROLLBACK_RESERVE_BYTES,
  PAYLOAD_EXPANSION_FACTOR
};
