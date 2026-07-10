const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");

const NODE_VERSION = "22.22.2";
const NODE_DIST_BASE = "https://nodejs.org/download/release";

async function ensurePrerequisites({ paths, platform, arch, emit }) {
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.nodeGlobalRoot, { recursive: true });

  const nodePaths = getNodeRuntimePaths(paths, platform, arch);
  if (fs.existsSync(nodePaths.nodeBinary) && fs.existsSync(nodePaths.npmBinary)) {
    if (nodePaths.npmCliJs && !fs.existsSync(nodePaths.npmCliJs)) {
      fs.rmSync(nodePaths.nodeHome, { recursive: true, force: true });
    } else {
      emit(`Using bundled Node.js runtime at ${nodePaths.nodeHome}`);
      return nodePaths;
    }
  }

  emit("Node.js/npm not bundled yet; downloading UCSD-managed runtime...");
  await installNodeRuntime({ paths, platform, emit, nodePaths });
  emit(`Node.js runtime ready at ${nodePaths.nodeHome}`);
  return nodePaths;
}

function getNodeRuntimePaths(paths, platform = process.platform, arch = process.arch) {
  const normalized = normalizePlatform(platform, arch);
  const archiveExt = platform === "win32" ? "zip" : "tar.gz";
  const nodeDirName = `node-v${NODE_VERSION}-${normalized.nodePlatform}-${normalized.nodeArch}`;
  const nodeHome = path.join(paths.nodeRoot, nodeDirName);
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
    archiveName: `${nodeDirName}.${archiveExt}`,
    archiveUrl: `${NODE_DIST_BASE}/v${NODE_VERSION}/${nodeDirName}.${archiveExt}`,
    shasumsUrl: `${NODE_DIST_BASE}/v${NODE_VERSION}/SHASUMS256.txt`
  };
}

async function installNodeRuntime({ paths, platform, emit, nodePaths }) {
  fs.rmSync(nodePaths.nodeHome, { recursive: true, force: true });
  fs.mkdirSync(paths.nodeRoot, { recursive: true });

  const archivePath = path.join(paths.cacheDir, nodePaths.archiveName);
  const shasumsPath = path.join(paths.cacheDir, `SHASUMS256-v${NODE_VERSION}.txt`);

  await download(nodePaths.archiveUrl, archivePath, emit);
  await download(nodePaths.shasumsUrl, shasumsPath, emit);
  verifyChecksum(archivePath, shasumsPath, nodePaths.archiveName);
  await extractArchive({ archivePath, destination: paths.nodeRoot, platform, emit });
}

function normalizePlatform(platform, arch) {
  const nodePlatform = {
    darwin: "darwin",
    linux: "linux",
    win32: "win"
  }[platform];

  const nodeArch = {
    arm64: "arm64",
    x64: "x64"
  }[arch];

  if (!nodePlatform || !nodeArch) {
    throw new Error(`Unsupported platform for bundled Node runtime: ${platform}/${arch}`);
  }

  return { nodePlatform, nodeArch };
}

function download(url, target, emit) {
  return new Promise<void>((resolve, reject) => {
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      emit(`Using cached ${path.basename(target)}`);
      resolve();
      return;
    }

    emit(`Downloading ${url}`);
    const file = fs.createWriteStream(target);
    https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        file.close();
        fs.rmSync(target, { force: true });
        download(response.headers.location, target, emit).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.rmSync(target, { force: true });
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close(resolve);
      });
    }).on("error", (error) => {
      file.close();
      fs.rmSync(target, { force: true });
      reject(error);
    });
  });
}

function verifyChecksum(archivePath, shasumsPath, archiveName) {
  const shasums = fs.readFileSync(shasumsPath, "utf8");
  const expectedLine = shasums.split(/\r?\n/).find((line) => line.endsWith(` ${archiveName}`));
  if (!expectedLine) {
    throw new Error(`No checksum found for ${archiveName}`);
  }

  const expected = expectedLine.split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (expected !== actual) {
    throw new Error(`Checksum mismatch for ${archiveName}`);
  }
}

function extractArchive({ archivePath, destination, platform, emit }) {
  if (platform === "win32") {
    return run(windowsPowerShellCommand(), [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
    ], emit);
  }

  return run("tar", ["-xzf", archivePath, "-C", destination], emit);
}

function windowsPowerShellCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const bundledPowerShell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(bundledPowerShell) ? bundledPowerShell : "powershell.exe";
}

function run(command, args, emit) {
  return new Promise<void>((resolve, reject) => {
    emit(`$ ${command} ${args.join(" ")}`);
    const child = spawn(command, args);
    child.stdout.on("data", (chunk) => emit(chunk.toString("utf8").trimEnd()));
    child.stderr.on("data", (chunk) => emit(chunk.toString("utf8").trimEnd()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

module.exports = { ensurePrerequisites, getNodeRuntimePaths, NODE_VERSION };
