const fs = require("fs");
const path = require("path");
const { defaultAppRoot } = require("./app-root");

const { CODEX_CLI_VERSION } = require("./npm-policy");

interface BundleOptions {
  resourcesPath?: string;
  appRoot?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

interface InstallBundledCodexOptions extends BundleOptions {
  paths: Record<string, string>;
  emit?: InstallerEmit;
}

interface ManagedCodexLauncherOptions {
  installRoot: string;
  nodeBinary: string;
  platform?: NodeJS.Platform;
}

function installBundledCodexCli({
  paths,
  platform = process.platform,
  arch = process.arch,
  resourcesPath,
  appRoot,
  emit = () => {},
}: InstallBundledCodexOptions) {
  const source = findBundledCodexDir({ resourcesPath, appRoot, platform, arch });
  if (!source) {
    emit("No valid bundled Codex CLI payload found.");
    return false;
  }

  emit(`Installing managed Codex ${CODEX_CLI_VERSION} from bundled ${codexTargetName(platform, arch)} payload...`);
  stageAndActivateBundledCodex({ source, target: paths.codexInstallRoot, platform, arch });

  return true;
}

function stageAndActivateBundledCodex({ source, target, platform = process.platform, arch = process.arch }) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(parent, ".codex-install-stage-"));
  const stagedInstall = path.join(stageRoot, "next");
  const backupRoot = fs.mkdtempSync(path.join(parent, ".codex-install-backup-"));
  const previousInstall = path.join(backupRoot, "previous");
  let previousMoved = false;
  let activationCompleted = false;

  try {
    fs.cpSync(source, stagedInstall, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (entry) => !entry.includes(`${path.sep}.git${path.sep}`) && !entry.endsWith(`${path.sep}.git`),
    });
    if (!isCodexVendorDir(stagedInstall, platform, arch)) {
      throw new Error(`Staged bundled Codex CLI payload is incomplete or has invalid identity for ${codexTargetName(platform, arch)}.`);
    }
    const stagedBinary = platform === "win32"
      ? path.join(stagedInstall, "codex.cmd")
      : path.join(stagedInstall, "bin", "codex");
    if (platform !== "win32") fs.chmodSync(stagedBinary, 0o755);

    if (fs.existsSync(target)) {
      fs.renameSync(target, previousInstall);
      previousMoved = true;
    }
    fs.renameSync(stagedInstall, target);
    activationCompleted = true;
  } catch (error) {
    if (previousMoved && !fs.existsSync(target)) {
      try {
        fs.renameSync(previousInstall, target);
        previousMoved = false;
      } catch (rollbackError) {
        throw new Error(
          `Could not activate bundled Codex CLI: ${error.message}. `
          + `Rollback also failed: ${rollbackError.message}`
        );
      }
    }
    throw error;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    if (activationCompleted || !previousMoved) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  }

  const binary = platform === "win32"
    ? path.join(target, "codex.cmd")
    : path.join(target, "bin", "codex");
  if (!fs.existsSync(binary)) {
    throw new Error(`Bundled Codex CLI activation did not retain the expected binary: ${binary}`);
  }
}

function findBundledCodexDir(options: BundleOptions = {}): string | null {
  let target;
  try {
    target = codexTargetName(options.platform || process.platform, options.arch || process.arch);
  } catch (_error) {
    return null;
  }
  const candidates = bundleBaseCandidates(options)
    .map((base) => path.join(base, "vendor", "codex-cli", target));

  return candidates.find((candidate) => isCodexVendorDir(
    candidate,
    options.platform || process.platform,
    options.arch || process.arch
  )) || null;
}

function isCodexVendorDir(
  candidate: string | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): boolean {
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false;
  let target;
  try {
    target = codexTargetName(platform, arch);
  } catch (_error) {
    return false;
  }
  const binary = platform === "win32"
    ? path.join(candidate, "codex.cmd")
    : path.join(candidate, "bin", "codex");
  const nativePackage = path.join(
    candidate,
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    platform === "win32" ? "codex-win32-x64" : "codex-darwin-arm64"
  );
  const manifest = readCodexVendorManifest(candidate);
  return manifest?.name === "@openai/codex"
    && manifest?.version === CODEX_CLI_VERSION
    && manifest?.target === target
    && isRegularFile(path.join(candidate, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"))
    && isRegularFile(binary)
    && isRealDirectory(nativePackage);
}

function isRegularFile(file) {
  return fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink();
}

function isRealDirectory(dir) {
  return fs.existsSync(dir) && fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink();
}

function readCodexVendorManifest(candidate) {
  try {
    return JSON.parse(fs.readFileSync(path.join(candidate, "manifest.json"), "utf8"));
  } catch (_error) {
    return null;
  }
}

function bundleBaseCandidates(options: BundleOptions = {}): string[] {
  const explicitResourcesPath = options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath;
  const appRoot = options.appRoot || defaultAppRoot(__dirname);

  return [
    explicitResourcesPath && path.join(explicitResourcesPath, "app"),
    explicitResourcesPath,
    appRoot,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function codexTargetName(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): string {
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  if (platform === "win32" && arch === "x64") return "win-x64";
  throw new Error(`Unsupported Codex CLI vendor target: ${platform}/${arch}`);
}

function managedCodexBinary(paths: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  return path.join(paths.codexBinDir, platform === "win32" ? "codex.cmd" : "codex");
}

function writeManagedCodexLauncher({
  installRoot,
  nodeBinary,
  platform = process.platform,
}: ManagedCodexLauncherOptions): string {
  const launcher = platform === "win32"
    ? path.join(installRoot, "codex.cmd")
    : path.join(installRoot, "bin", "codex");
  const launcherDir = path.dirname(launcher);
  const codexJs = managedCodexEntrypoint(installRoot, platform);
  const relativeNodeBinary = path.relative(launcherDir, nodeBinary);
  const relativeCodexJs = path.relative(launcherDir, codexJs);

  if (!isRegularFile(nodeBinary)) {
    throw new Error(`Managed Node.js runtime is missing: ${nodeBinary}`);
  }
  if (!relativeNodeBinary || !relativeCodexJs || path.isAbsolute(relativeNodeBinary) || path.isAbsolute(relativeCodexJs)) {
    throw new Error(`Managed Node.js runtime must share a filesystem root with managed Codex: ${nodeBinary}`);
  }

  if (platform === "win32") {
    const windowsNodePath = relativeNodeBinary.replaceAll("/", "\\");
    const windowsCodexPath = relativeCodexJs.replaceAll("/", "\\");
    fs.writeFileSync(launcher, [
      "@echo off",
      "setlocal",
      "set \"SCRIPT_DIR=%~dp0\"",
      `set \"NODE_BIN=%SCRIPT_DIR%${windowsNodePath}\"`,
      "if not exist \"%NODE_BIN%\" (",
      "  echo Managed Node.js runtime is missing: %NODE_BIN% 1>&2",
      "  exit /b 127",
      ")",
      `"%NODE_BIN%" "%SCRIPT_DIR%${windowsCodexPath}" %*`,
      "",
    ].join("\r\n"));
    return launcher;
  }

  const posixNodePath = relativeNodeBinary.split(path.sep).join("/");
  const posixCodexPath = relativeCodexJs.split(path.sep).join("/");
  fs.writeFileSync(launcher, [
    "#!/usr/bin/env sh",
    "set -eu",
    "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    `NODE_BIN=\"$SCRIPT_DIR/${posixNodePath}\"`,
    "if [ ! -x \"$NODE_BIN\" ]; then",
    "  echo \"Managed Node.js runtime is missing or not executable: $NODE_BIN\" >&2",
    "  exit 127",
    "fi",
    `exec "$NODE_BIN" "$SCRIPT_DIR/${posixCodexPath}" "$@"`,
    "",
  ].join("\n"));
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

function managedCodexEntrypoint(installRoot: string, platform: NodeJS.Platform): string {
  const packagePath = ["@openai", "codex", "bin", "codex.js"];
  const bundledEntrypoint = path.join(installRoot, "lib", "node_modules", ...packagePath);
  const candidates = platform === "win32"
    ? [path.join(installRoot, "node_modules", ...packagePath), bundledEntrypoint]
    : [bundledEntrypoint];
  const entrypoint = candidates.find(isRegularFile);
  if (!entrypoint) {
    throw new Error(`Managed Codex entrypoint is missing: ${candidates.join(" or ")}`);
  }
  return entrypoint;
}

module.exports = {
  installBundledCodexCli,
  findBundledCodexDir,
  isCodexVendorDir,
  stageAndActivateBundledCodex,
  codexTargetName,
  writeManagedCodexLauncher,
};
