const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { NPM_POLICY, CODEX_CLI_VERSION } = require("../src/installer/npm-policy");

const root = path.resolve(__dirname, "..");
const codexPackage = `@openai/codex@${CODEX_CLI_VERSION}`;
const codexTargets = {
  "mac-arm64": {
    os: "darwin",
    cpu: "arm64",
    vendorDir: path.join(root, "vendor", "codex-cli", "mac-arm64"),
    binPath: path.join("bin", "codex"),
    nativePackageDir: path.join("lib", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-darwin-arm64"),
  },
  "win-x64": {
    os: "win32",
    cpu: "x64",
    vendorDir: path.join(root, "vendor", "codex-cli", "win-x64"),
    binPath: "codex.cmd",
    nativePackageDir: path.join("lib", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64"),
  },
};

function main() {
  const target = process.argv[2] || process.env.UCSD_CODEX_VENDOR_TARGET || defaultTarget();

  if (target === "all") {
    for (const targetName of Object.keys(codexTargets)) {
      stageCodexVendor(targetName);
    }
    return;
  }

  stageCodexVendor(target);
}

function defaultTarget() {
  return process.platform === "darwin" ? "mac-arm64" : "win-x64";
}

function stageCodexVendor(targetName) {
  const target = codexTargets[targetName];
  if (!target) {
    throw new Error(`Unsupported Codex CLI vendor target: ${targetName}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ucsd-codex-cli-${targetName}-`));
  try {
    run(npmCommand(), [
      "install",
      "-g",
      "--prefix",
      tempRoot,
      "--os",
      target.os,
      "--cpu",
      target.cpu,
      "--before",
      NPM_POLICY.cutoffDate,
      codexPackage,
    ]);

    normalizeNpmGlobalLayout(tempRoot);
    writePosixCommandShim(tempRoot);
    if (target.os === "win32") {
      writeWindowsCommandShim(tempRoot);
    }

    verifyStagedCodex(tempRoot, targetName, target);
    fs.rmSync(target.vendorDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target.vendorDir), { recursive: true });
    fs.cpSync(tempRoot, target.vendorDir, { recursive: true, force: true });
    writeManifest(target.vendorDir, targetName, target);
    console.log(`Prepared ${path.relative(root, target.vendorDir)}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function normalizeNpmGlobalLayout(prefix) {
  const expectedRoot = path.join(prefix, "lib", "node_modules");
  const expectedCodex = path.join(expectedRoot, "@openai", "codex");
  if (fs.existsSync(expectedCodex)) {
    return;
  }

  const windowsRoot = path.join(prefix, "node_modules");
  const windowsCodex = path.join(windowsRoot, "@openai", "codex");
  if (!fs.existsSync(windowsCodex)) {
    return;
  }

  fs.mkdirSync(path.dirname(expectedRoot), { recursive: true });
  fs.rmSync(expectedRoot, { recursive: true, force: true });
  fs.renameSync(windowsRoot, expectedRoot);
}

function verifyStagedCodex(prefix, targetName, target) {
  assertFile(path.join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"));
  assertFile(path.join(prefix, target.binPath));
  const nativePackageDir = path.join(prefix, target.nativePackageDir);
  if (!fs.existsSync(nativePackageDir) || !fs.statSync(nativePackageDir).isDirectory()) {
    throw new Error(`Codex ${targetName} native package is missing: ${nativePackageDir}`);
  }
}

function writeWindowsCommandShim(prefix) {
  fs.writeFileSync(path.join(prefix, "codex.cmd"), [
    "@echo off",
    "setlocal",
    "set \"SCRIPT_DIR=%~dp0\"",
    "node \"%SCRIPT_DIR%lib\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
    "",
  ].join("\r\n"));
}

function writePosixCommandShim(prefix) {
  const binDir = path.join(prefix, "bin");
  const binPath = path.join(binDir, "codex");
  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(binPath, { force: true });
  fs.writeFileSync(binPath, [
    "#!/usr/bin/env sh",
    "set -eu",
    "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "exec node \"$SCRIPT_DIR/../lib/node_modules/@openai/codex/bin/codex.js\" \"$@\"",
    "",
  ].join("\n"));
  fs.chmodSync(binPath, 0o755);
}

function writeManifest(vendorDir, targetName, target) {
  const manifest = {
    name: "@openai/codex",
    version: CODEX_CLI_VERSION,
    target: targetName,
    os: target.os,
    cpu: target.cpu,
    npmPolicy: {
      before: NPM_POLICY.cutoffDate,
    },
  };
  fs.writeFileSync(path.join(vendorDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Expected Codex vendor file to exist: ${file}`);
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  codexTargets,
  normalizeNpmGlobalLayout,
  stageCodexVendor,
};
