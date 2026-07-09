const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "artifacts", "macos-fast-test");
const baseConfigPath = path.join(root, "electron-builder.mac.json");
const builderCli = path.join(root, "node_modules", "electron-builder", "cli.js");

function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS test packaging must run on macOS.");
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  prepareManagedConfig();
  prepareVendorArtifacts();

  const tempConfig = writeFastTestConfig();
  try {
    run(process.execPath, [
      builderCli,
      "--mac",
      "--arm64",
      "--dir",
      "--config",
      tempConfig,
      "--publish",
      "never"
    ], {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
    });
  } finally {
    fs.rmSync(tempConfig, { force: true });
  }

  const appPath = path.join(outputDir, "mac-arm64", "TritonAI Installer.app");
  if (!fs.existsSync(appPath)) {
    throw new Error(`Fast test build did not create ${appPath}`);
  }
  run(process.execPath, [path.join(root, "scripts", "verify-macos-bundled-resources.js"), appPath]);

  console.log(`Fast macOS test artifacts ready: ${path.relative(root, outputDir)}`);
  console.log("These artifacts are intentionally not Developer ID signed or notarized.");
}

function writeFastTestConfig() {
  const config = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));
  config.directories = {
    ...(config.directories || {}),
    output: "artifacts/macos-fast-test"
  };
  config.mac = {
    ...(config.mac || {}),
    forceCodeSigning: false,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    identity: null
  };
  delete config.mac.entitlements;
  delete config.mac.entitlementsInherit;
  delete config.dmg;

  const tempConfig = path.join(os.tmpdir(), `tritonai-fast-mac-${process.pid}.json`);
  fs.writeFileSync(tempConfig, JSON.stringify(config, null, 2));
  return tempConfig;
}

function prepareVendorArtifacts() {
  run(process.execPath, [path.join(root, "scripts", "prepare-t3code-desktop-vendor.js")]);
  run(process.execPath, [path.join(root, "scripts", "prepare-codex-cli-vendor.js"), "mac-arm64"]);
  run(process.execPath, [path.join(root, "scripts", "prepare-skills-vendor.js")]);
}

function prepareManagedConfig() {
  run(process.execPath, [path.join(root, "scripts", "write-managed-config.js")]);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

main();
