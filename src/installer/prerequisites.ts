const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");
const { defaultAppRoot } = require("./app-root");
const { terminateProcessTree } = require("./process-termination");
const {
  recoverInterruptedDirectoryTransaction,
  writeDirectoryTransactionJournal
} = require("./directory-transaction");

const NODE_VERSION = "22.23.2";
const NODE_DIST_BASE = "https://nodejs.org/download/release";
const NODE_ARCHIVE_SHA256 = Object.freeze({
  "mac-arm64": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  "win-x64": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
});
const NODE_VENDOR_SCHEMA_VERSION = 1;
const NODE_RUNTIME_MARKER = ".tritonai-node-runtime.json";
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DOWNLOAD_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const NODE_TRANSACTION_JOURNAL_FILE = ".node-runtime-transaction.json";
const NODE_STAGE_PREFIX = ".node-runtime-stage-";
const NODE_BACKUP_PREFIX = ".node-runtime-backup-";
const NODE_TRANSACTION_KIND = "managed Node.js runtime";
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000;

interface NodeBundleOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  resourcesPath?: string;
  appRoot?: string;
}

interface DownloadOptions {
  attempts?: number;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxBytes?: number;
  requestFactory?: typeof https.get;
}

async function ensurePrerequisites({
  paths,
  platform,
  arch,
  emit,
  resourcesPath,
  appRoot,
  packaged = false,
  extractArchive: archiveExtractor = extractArchive
}) {
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.nodeGlobalRoot, { recursive: true });

  const nodePaths = getNodeRuntimePaths(paths, platform, arch);
  recoverInterruptedNodeRuntime({ paths, nodePaths, platform, arch, emit });
  if (isInstalledNodeRuntime(nodePaths, platform, arch)) {
    emit(`Using managed Node.js runtime at ${nodePaths.nodeHome}`);
    return nodePaths;
  }

  const bundled = findBundledNodeArchive({ platform, arch, resourcesPath, appRoot });
  if (bundled) {
    emit(`Installing managed Node.js ${NODE_VERSION} from the bundled ${bundled.manifest.target} runtime...`);
    await installNodeRuntimeFromArchive({
      archivePath: bundled.archivePath,
      expectedSha256: bundled.manifest.archive.sha256,
      expectedSize: bundled.manifest.archive.size,
      paths,
      platform,
      arch,
      emit,
      nodePaths,
      archiveExtractor
    });
  } else {
    if (packaged) {
      throw new Error(
        `This packaged TritonAI Installer is missing a valid bundled Node.js runtime for ${nodeTargetName(platform, arch)}.`
      );
    }
    emit("Node.js runtime is not packaged in this development build; downloading the pinned runtime...");
    await installNodeRuntimeFromNetwork({
      paths,
      platform,
      arch,
      emit,
      nodePaths,
      archiveExtractor
    });
  }

  if (!isInstalledNodeRuntime(nodePaths, platform, arch)) {
    throw new Error(`Managed Node.js runtime validation failed after installation: ${nodePaths.nodeHome}`);
  }
  emit(`Node.js runtime ready at ${nodePaths.nodeHome}`);
  return nodePaths;
}

function getNodeRuntimePaths(paths, platform = process.platform, arch = process.arch) {
  const distribution = getNodeDistribution(platform, arch);
  const nodeHome = path.join(paths.nodeRoot, distribution.nodeDirName);
  const nodeBinDir = platform === "win32" ? nodeHome : path.join(nodeHome, "bin");

  return {
    version: NODE_VERSION,
    nodeHome,
    nodeBinDir,
    nodeBinary: path.join(nodeBinDir, platform === "win32" ? "node.exe" : "node"),
    npmBinary: path.join(nodeBinDir, platform === "win32" ? "npm.cmd" : "npm"),
    npmCliJs: path.join(
      nodeHome,
      platform === "win32" ? "node_modules" : path.join("lib", "node_modules"),
      "npm",
      "bin",
      "npm-cli.js"
    ),
    runtimeMarker: path.join(nodeHome, NODE_RUNTIME_MARKER),
    ...distribution
  };
}

function getNodeDistribution(platform = process.platform, arch = process.arch) {
  const normalized = normalizePlatform(platform, arch);
  const target = nodeTargetName(platform, arch);
  const archiveExt = platform === "win32" ? "zip" : "tar.gz";
  const nodeDirName = `node-v${NODE_VERSION}-${normalized.nodePlatform}-${normalized.nodeArch}`;
  const archiveName = `${nodeDirName}.${archiveExt}`;
  return {
    target,
    nodeDirName,
    archiveName,
    archiveUrl: `${NODE_DIST_BASE}/v${NODE_VERSION}/${archiveName}`,
    shasumsUrl: `${NODE_DIST_BASE}/v${NODE_VERSION}/SHASUMS256.txt`,
    sha256: NODE_ARCHIVE_SHA256[target]
  };
}

function nodeTargetName(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  if (platform === "win32" && arch === "x64") return "win-x64";
  throw new Error(`Unsupported bundled Node runtime target: ${platform}/${arch}`);
}

function normalizePlatform(platform, arch) {
  const nodePlatform = { darwin: "darwin", linux: "linux", win32: "win" }[platform];
  const nodeArch = { arm64: "arm64", x64: "x64" }[arch];
  if (!nodePlatform || !nodeArch) {
    throw new Error(`Unsupported platform for bundled Node runtime: ${platform}/${arch}`);
  }
  return { nodePlatform, nodeArch };
}

function isInstalledNodeRuntime(nodePaths, platform, arch) {
  if (![nodePaths.nodeBinary, nodePaths.npmBinary, nodePaths.npmCliJs].every(isRegularFileOrExecutableLink)) {
    return false;
  }
  try {
    const marker = JSON.parse(fs.readFileSync(nodePaths.runtimeMarker, "utf8"));
    return marker.schemaVersion === NODE_VENDOR_SCHEMA_VERSION
      && marker.name === "node"
      && marker.version === NODE_VERSION
      && marker.target === nodeTargetName(platform, arch)
      && /^[a-f0-9]{64}$/.test(marker.archiveSha256 || "");
  } catch (_error) {
    return false;
  }
}

function isRegularFileOrExecutableLink(file) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return stat.isFile() || stat.isSymbolicLink();
}

async function installNodeRuntimeFromNetwork({
  paths,
  platform,
  arch,
  emit,
  nodePaths,
  archiveExtractor = extractArchive
}) {
  const archivePath = path.join(paths.cacheDir, nodePaths.archiveName);
  const shasumsPath = path.join(paths.cacheDir, `SHASUMS256-v${NODE_VERSION}.txt`);
  await downloadFileAtomic(nodePaths.shasumsUrl, shasumsPath, emit);
  const publishedSha256 = checksumForArchive(shasumsPath, nodePaths.archiveName);
  if (publishedSha256 !== nodePaths.sha256) {
    throw new Error(`Published checksum does not match the reviewed digest for ${nodePaths.archiveName}`);
  }
  const expectedSha256 = nodePaths.sha256;

  if (fs.existsSync(archivePath)) {
    try {
      verifyArchive(archivePath, { sha256: expectedSha256 });
      emit(`Using verified cached ${path.basename(archivePath)}`);
    } catch (_error) {
      emit(`Discarding incomplete or invalid cached ${path.basename(archivePath)}.`);
      fs.rmSync(archivePath, { force: true });
    }
  }
  if (!fs.existsSync(archivePath)) {
    await downloadFileAtomic(nodePaths.archiveUrl, archivePath, emit);
  }

  try {
    verifyArchive(archivePath, { sha256: expectedSha256 });
  } catch (_error) {
    fs.rmSync(archivePath, { force: true });
    emit(`Checksum validation failed for ${nodePaths.archiveName}; downloading one clean retry.`);
    await downloadFileAtomic(nodePaths.archiveUrl, archivePath, emit);
    verifyArchive(archivePath, { sha256: expectedSha256 });
  }

  await installNodeRuntimeFromArchive({
    archivePath,
    expectedSha256,
    paths,
    platform,
    arch,
    emit,
    nodePaths,
    archiveExtractor
  });
}

async function installNodeRuntimeFromArchive({
  archivePath,
  expectedSha256,
  expectedSize = undefined,
  paths,
  platform,
  arch,
  emit,
  nodePaths = getNodeRuntimePaths(paths, platform, arch),
  archiveExtractor = extractArchive
}) {
  verifyArchive(archivePath, { sha256: expectedSha256, size: expectedSize });
  fs.mkdirSync(paths.nodeRoot, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(paths.nodeRoot, NODE_STAGE_PREFIX));
  const backupRoot = fs.mkdtempSync(path.join(paths.nodeRoot, NODE_BACKUP_PREFIX));
  const journalPath = path.join(paths.nodeRoot, NODE_TRANSACTION_JOURNAL_FILE);
  const stagedNodeHome = path.join(stageRoot, nodePaths.nodeDirName);
  const previousNodeHome = path.join(backupRoot, nodePaths.nodeDirName);
  let previousMoved = false;
  let replacementActivated = false;
  let replacementCompleted = false;

  try {
    await archiveExtractor({ archivePath, destination: stageRoot, platform, emit });
    assertExtractedNodeRuntime(stagedNodeHome, platform);
    fs.writeFileSync(path.join(stagedNodeHome, NODE_RUNTIME_MARKER), `${JSON.stringify({
      schemaVersion: NODE_VENDOR_SCHEMA_VERSION,
      name: "node",
      version: NODE_VERSION,
      target: nodeTargetName(platform, arch),
      archiveSha256: expectedSha256
    }, null, 2)}\n`);

    writeDirectoryTransactionJournal({
      journalPath,
      kind: NODE_TRANSACTION_KIND,
      target: nodePaths.nodeHome,
      stageRoot,
      backupRoot,
      stagePrefix: NODE_STAGE_PREFIX,
      backupPrefix: NODE_BACKUP_PREFIX,
      stagedName: nodePaths.nodeDirName,
      backupName: nodePaths.nodeDirName,
      hadPrevious: fs.existsSync(nodePaths.nodeHome)
    });

    if (fs.existsSync(nodePaths.nodeHome)) {
      fs.renameSync(nodePaths.nodeHome, previousNodeHome);
      previousMoved = true;
    }
    fs.renameSync(stagedNodeHome, nodePaths.nodeHome);
    replacementActivated = true;
    if (!isInstalledNodeRuntime(nodePaths, platform, arch)) {
      throw new Error(`Activated Node.js runtime is incomplete: ${nodePaths.nodeHome}`);
    }
    replacementCompleted = true;
  } catch (error) {
    if (previousMoved) {
      try {
        fs.rmSync(nodePaths.nodeHome, { recursive: true, force: true });
        fs.renameSync(previousNodeHome, nodePaths.nodeHome);
        previousMoved = false;
      } catch (rollbackError) {
        throw new Error(
          `Could not activate managed Node.js runtime: ${error.message}. `
          + `Rollback also failed: ${rollbackError.message}`
        );
      }
    } else if (replacementActivated) {
      fs.rmSync(nodePaths.nodeHome, { recursive: true, force: true });
    }
    throw error;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    if (replacementCompleted || !previousMoved) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
    if (replacementCompleted) fs.rmSync(journalPath, { force: true });
  }
}

function recoverInterruptedNodeRuntime({ paths, nodePaths, platform, arch, emit }) {
  fs.mkdirSync(paths.nodeRoot, { recursive: true });
  return recoverInterruptedDirectoryTransaction({
    journalPath: path.join(paths.nodeRoot, NODE_TRANSACTION_JOURNAL_FILE),
    kind: NODE_TRANSACTION_KIND,
    target: nodePaths.nodeHome,
    stagePrefix: NODE_STAGE_PREFIX,
    backupPrefix: NODE_BACKUP_PREFIX,
    validate: (candidate) => isInstalledNodeRuntime(nodePathsAtHome(nodePaths, candidate), platform, arch),
    emit
  });
}

function nodePathsAtHome(nodePaths, nodeHome) {
  const nodeBinDir = path.basename(nodePaths.nodeBinDir) === "bin" ? path.join(nodeHome, "bin") : nodeHome;
  return {
    ...nodePaths,
    nodeHome,
    nodeBinDir,
    nodeBinary: path.join(nodeBinDir, path.basename(nodePaths.nodeBinary)),
    npmBinary: path.join(nodeBinDir, path.basename(nodePaths.npmBinary)),
    npmCliJs: path.join(
      nodeHome,
      path.relative(nodePaths.nodeHome, nodePaths.npmCliJs)
    ),
    runtimeMarker: path.join(nodeHome, NODE_RUNTIME_MARKER)
  };
}

function assertExtractedNodeRuntime(nodeHome, platform) {
  const binDir = platform === "win32" ? nodeHome : path.join(nodeHome, "bin");
  const required = [
    path.join(binDir, platform === "win32" ? "node.exe" : "node"),
    path.join(binDir, platform === "win32" ? "npm.cmd" : "npm"),
    path.join(
      nodeHome,
      platform === "win32" ? "node_modules" : path.join("lib", "node_modules"),
      "npm",
      "bin",
      "npm-cli.js"
    )
  ];
  const missing = required.filter((file) => !isRegularFileOrExecutableLink(file));
  if (missing.length > 0) {
    throw new Error(`Bundled Node.js runtime is incomplete: ${missing.join(", ")}`);
  }
}

function findBundledNodeArchive(options: NodeBundleOptions = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = nodeTargetName(platform, arch);
  const candidates = bundleBaseCandidates(options)
    .map((base) => path.join(base, "vendor", "node-runtime", target));

  for (const vendorDir of candidates) {
    const manifestPath = path.join(vendorDir, "manifest.json");
    if (!isRegularFile(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (_error) {
      continue;
    }
    if (!isValidNodeVendorManifest(manifest, platform, arch)) continue;
    const archivePath = path.join(vendorDir, manifest.archive.name);
    if (!isRegularFile(archivePath)) continue;
    try {
      verifyArchive(archivePath, manifest.archive);
      return { vendorDir, manifestPath, archivePath, manifest };
    } catch (_error) {
      continue;
    }
  }
  return null;
}

function isValidNodeVendorManifest(manifest, platform, arch) {
  const distribution = getNodeDistribution(platform, arch);
  return manifest?.schemaVersion === NODE_VENDOR_SCHEMA_VERSION
    && manifest?.name === "node"
    && manifest?.version === NODE_VERSION
    && manifest?.target === distribution.target
    && manifest?.archive?.name === distribution.archiveName
    && Number.isSafeInteger(manifest?.archive?.size)
    && manifest.archive.size > 0
    && /^[a-f0-9]{64}$/.test(manifest?.archive?.sha256 || "");
}

function bundleBaseCandidates(options: NodeBundleOptions = {}) {
  const explicitResourcesPath = options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath;
  return [
    explicitResourcesPath && path.join(explicitResourcesPath, "app"),
    explicitResourcesPath,
    options.appRoot || defaultAppRoot(__dirname)
  ].filter(Boolean);
}

function isRegularFile(file) {
  return fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink();
}

function checksumForArchive(shasumsPath, archiveName) {
  const shasums = fs.readFileSync(shasumsPath, "utf8");
  const expectedLine = shasums.split(/\r?\n/).find((line) => line.endsWith(`  ${archiveName}`) || line.endsWith(` ${archiveName}`));
  if (!expectedLine) throw new Error(`No checksum found for ${archiveName}`);
  const expected = expectedLine.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid checksum for ${archiveName}`);
  return expected;
}

function verifyArchive(archivePath, expected) {
  const stat = fs.statSync(archivePath);
  if (Number.isFinite(expected.size) && stat.size !== expected.size) {
    throw new Error(`Size mismatch for ${path.basename(archivePath)}: expected ${expected.size}, got ${stat.size}`);
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (actual !== expected.sha256) {
    throw new Error(`SHA-256 mismatch for ${path.basename(archivePath)}`);
  }
  return actual;
}

async function downloadFileAtomic(url, target, emit: InstallerEmit = () => {}, options: DownloadOptions = {}) {
  const attempts = options.attempts || DEFAULT_DOWNLOAD_ATTEMPTS;
  const timeoutMs = options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs || DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const temp = `${target}.partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      emit(`Downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ""}`);
      await downloadAttempt(url, temp, {
        timeoutMs,
        totalTimeoutMs,
        maxBytes: options.maxBytes,
        redirectsRemaining: MAX_REDIRECTS,
        requestFactory: options.requestFactory || https.get
      });
      fs.rmSync(target, { force: true });
      fs.renameSync(temp, target);
      return target;
    } catch (error) {
      lastError = error;
      fs.rmSync(temp, { force: true });
      if (attempt < attempts) await new Promise<void>((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw new Error(`Download failed after ${attempts} attempts: ${url}. ${lastError?.message || lastError}`);
}

function downloadAttempt(url, target, { timeoutMs, totalTimeoutMs, maxBytes, redirectsRemaining, requestFactory }) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let activeRequest = null;
    let activeResponse = null;
    let activeFile = null;
    let totalTimer;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (error) {
        activeRequest?.destroy();
        activeResponse?.destroy();
        activeFile?.destroy();
      }
      if (error) reject(error);
      else resolve();
    };
    totalTimer = setTimeout(() => {
      finish(new Error(`Download exceeded the ${totalTimeoutMs} ms total timeout: ${url}`));
    }, totalTimeoutMs);

    const requestUrl = (currentUrl, remainingRedirects) => {
      if (settled) return;
      let request;
      try {
        request = requestFactory(currentUrl, (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          activeResponse = response;
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            if (!response.headers.location || remainingRedirects <= 0) {
              finish(new Error(`Too many or invalid redirects while downloading ${currentUrl}`));
              return;
            }
            requestUrl(new URL(response.headers.location, currentUrl).toString(), remainingRedirects - 1);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume();
            finish(new Error(`Download failed with HTTP ${response.statusCode}: ${currentUrl}`));
            return;
          }

          const expectedLength = Number(response.headers["content-length"] || 0);
          if (Number.isFinite(maxBytes) && maxBytes >= 0 && expectedLength > maxBytes) {
            response.resume();
            finish(new Error(`Download exceeds the ${maxBytes}-byte limit: ${currentUrl}`));
            return;
          }
          let received = 0;
          const file = fs.createWriteStream(target, { flags: "wx" });
          activeFile = file;
          response.on("data", (chunk) => {
            received += chunk.length;
            if (Number.isFinite(maxBytes) && maxBytes >= 0 && received > maxBytes) {
              finish(new Error(`Download exceeds the ${maxBytes}-byte limit: ${currentUrl}`));
            }
          });
          response.on("aborted", () => finish(new Error(`Download was interrupted: ${currentUrl}`)));
          response.on("error", finish);
          file.on("error", finish);
          file.on("finish", () => {
            file.close((error) => {
              if (error) return finish(error);
              if (expectedLength > 0 && received !== expectedLength) {
                return finish(new Error(`Incomplete download for ${currentUrl}: expected ${expectedLength} bytes, received ${received}`));
              }
              finish();
            });
          });
          response.pipe(file);
        });
      } catch (error) {
        finish(error);
        return;
      }
      activeRequest = request;
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`Download was idle for ${timeoutMs} ms: ${currentUrl}`)));
      request.on("error", finish);
    };

    requestUrl(url, redirectsRemaining);
  });
}

async function extractArchive({ archivePath, destination, platform, emit }) {
  if (platform === "win32") {
    try {
      await runExtractionCommand(windowsTarCommand(), ["-xf", archivePath, "-C", destination], emit);
      return;
    } catch (tarError) {
      if (!shouldFallbackWindowsExtraction(tarError)) throw tarError;
      emit(`Windows tar extraction failed; trying PowerShell Expand-Archive. ${tarError.message}`);
      await runExtractionCommand(windowsPowerShellCommand(), [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
      ], emit);
      return;
    }
  }
  await runExtractionCommand("tar", ["-xzf", archivePath, "-C", destination], emit);
}

function shouldFallbackWindowsExtraction(error) {
  return !["ETIMEDOUT", "ETERMINATE"].includes(error && error.code);
}

function windowsTarCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const bundledTar = path.join(systemRoot, "System32", "tar.exe");
  return fs.existsSync(bundledTar) ? bundledTar : "tar.exe";
}

function windowsPowerShellCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const bundledPowerShell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(bundledPowerShell) ? bundledPowerShell : "powershell.exe";
}

function runExtractionCommand(command, args, emit, {
  timeoutMs = EXTRACTION_TIMEOUT_MS,
  platform = process.platform,
  terminate = terminateProcessTree
} = {}) {
  return new Promise<void>((resolve, reject) => {
    emit(`$ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { shell: false, detached: platform !== "win32" });
    let settled = false;
    let timingOut = false;
    const timer = setTimeout(() => {
      if (settled || timingOut) return;
      timingOut = true;
      void terminate(child, { platform }).then(() => {
        finish(Object.assign(
          new Error(`${command} extraction timed out after ${timeoutMs}ms and its process tree was terminated`),
          { code: "ETIMEDOUT" }
        ));
      }, (terminationError) => {
        finish(Object.assign(new Error(
          `${command} extraction timed out after ${timeoutMs}ms and termination could not be confirmed: ${terminationError.message}`,
          { cause: terminationError }
        ), { code: "ETERMINATE" }));
      });
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", (chunk) => emit(chunk.toString("utf8").trimEnd()));
    child.stderr.on("data", (chunk) => emit(chunk.toString("utf8").trimEnd()));
    child.on("error", (error) => {
      if (timingOut) return;
      finish(error);
    });
    child.on("close", (code) => {
      if (timingOut) return;
      finish(code === 0 ? null : new Error(`${command} exited with code ${code}`));
    });
  });
}

module.exports = {
  ensurePrerequisites,
  getNodeRuntimePaths,
  getNodeDistribution,
  nodeTargetName,
  findBundledNodeArchive,
  installNodeRuntimeFromArchive,
  recoverInterruptedNodeRuntime,
  downloadFileAtomic,
  checksumForArchive,
  verifyArchive,
  runExtractionCommand,
  shouldFallbackWindowsExtraction,
  NODE_VERSION,
  NODE_ARCHIVE_SHA256,
  NODE_VENDOR_SCHEMA_VERSION,
  NODE_TRANSACTION_JOURNAL_FILE,
  NODE_STAGE_PREFIX,
  NODE_BACKUP_PREFIX
};
