const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));

const ELECTRON_VERSION = pkg.devDependencies.electron;
const PRODUCT_NAME = "TritonAI Installer";
const ELECTRON_ZIP = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const ELECTRON_URL = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ELECTRON_ZIP}`;

const artifactsDir = path.join(root, "artifacts", "windows");
const cacheDir = path.join(root, ".cache", "electron");
const buildRoot = path.join(root, "dist", "win32-x64-portable");
const appDir = path.join(buildRoot, PRODUCT_NAME);
const resourcesApp = path.join(appDir, "resources", "app");
const outputZip = path.join(artifactsDir, `${PRODUCT_NAME.replaceAll(" ", "-")}-win32-x64-portable.zip`);

function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(buildRoot, { recursive: true });

  const electronZip = path.join(cacheDir, ELECTRON_ZIP);
  downloadIfNeeded(ELECTRON_URL, electronZip);

  console.log(`Extracting ${ELECTRON_ZIP}...`);
  execFileSync("ditto", ["-x", "-k", electronZip, appDir], { stdio: "inherit" });

  fs.renameSync(path.join(appDir, "electron.exe"), path.join(appDir, `${PRODUCT_NAME}.exe`));
  fs.rmSync(path.join(appDir, "resources", "default_app.asar"), { force: true });

  fs.mkdirSync(resourcesApp, { recursive: true });
  copyFile("package.json", path.join(resourcesApp, "package.json"));
  copyTree(path.join(root, "src"), path.join(resourcesApp, "src"));
  copyTree(path.join(root, "docs"), path.join(resourcesApp, "docs"));
  copyFile("README.md", path.join(resourcesApp, "README.md"));
  prepareManagedConfig();
  copyFile("build/managed-config.generated.json", path.join(resourcesApp, "managed-config.json"));
  prepareSkillsVendor();
  copyTree(path.join(root, "vendor", "skills"), path.join(resourcesApp, "vendor", "skills"));
  prepareT3CodeDesktopVendor();
  copyTree(path.join(root, "vendor", "t3code-desktop", "win-x64"), path.join(resourcesApp, "vendor", "t3code-desktop", "win-x64"));
  prepareCodexCliVendor();
  copyTree(path.join(root, "vendor", "codex-cli", "win-x64"), path.join(resourcesApp, "vendor", "codex-cli", "win-x64"));

  fs.rmSync(outputZip, { force: true });
  console.log(`Creating ${outputZip}...`);
  execFileSync("zip", ["-X", "-q", "-r", outputZip, path.basename(appDir)], {
    cwd: buildRoot,
    stdio: "inherit"
  });

  const stat = fs.statSync(outputZip);
  console.log(`Windows portable app written to ${outputZip}`);
  console.log(`Size: ${formatBytes(stat.size)}`);
}

function prepareSkillsVendor() {
  execFileSync(process.execPath, [path.join(root, "scripts", "prepare-skills-vendor.js")], {
    cwd: root,
    stdio: "inherit"
  });
}

function prepareManagedConfig() {
  execFileSync(process.execPath, [path.join(root, "scripts", "write-managed-config.js")], {
    cwd: root,
    stdio: "inherit"
  });
}

function prepareT3CodeDesktopVendor() {
  execFileSync(process.execPath, [path.join(root, "scripts", "prepare-t3code-desktop-vendor.js"), "win-x64"], {
    cwd: root,
    stdio: "inherit"
  });
}

function prepareCodexCliVendor() {
  execFileSync(process.execPath, [path.join(root, "scripts", "prepare-codex-cli-vendor.js"), "win-x64"], {
    cwd: root,
    stdio: "inherit"
  });
}

function downloadIfNeeded(url, target) {
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log(`Using cached ${path.basename(target)}`);
    return;
  }

  console.log(`Downloading ${url}...`);
  const temp = path.join(os.tmpdir(), `${path.basename(target)}.${process.pid}.tmp`);
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

function copyFile(relative, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}

function copyTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (entry) => !entry.includes(`${path.sep}.DS_Store`)
  });
}

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

main();
