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
    emit("No bundled Codex CLI payload found; falling back to managed npm install.");
    return false;
  }

  emit(`Installing managed Codex ${CODEX_CLI_VERSION} from bundled ${codexTargetName(platform, arch)} payload...`);
  fs.rmSync(paths.codexInstallRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(paths.codexInstallRoot), { recursive: true });
  fs.cpSync(source, paths.codexInstallRoot, {
    recursive: true,
    force: true,
    filter: (entry) => !entry.includes(`${path.sep}.git${path.sep}`) && !entry.endsWith(`${path.sep}.git`),
  });

  const binary = managedCodexBinary(paths, platform);
  if (!fs.existsSync(binary)) {
    throw new Error(`Bundled Codex CLI payload did not install the expected binary: ${binary}`);
  }
  if (platform !== "win32") {
    fs.chmodSync(binary, 0o755);
  }

  return true;
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

  return candidates.find((candidate) => isCodexVendorDir(candidate, options.platform || process.platform)) || null;
}

function isCodexVendorDir(candidate: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false;
  const binary = platform === "win32"
    ? path.join(candidate, "codex.cmd")
    : path.join(candidate, "bin", "codex");
  return fs.existsSync(path.join(candidate, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"))
    && fs.existsSync(binary);
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

module.exports = {
  installBundledCodexCli,
  findBundledCodexDir,
  codexTargetName,
};
