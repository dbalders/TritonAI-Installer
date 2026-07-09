const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const required = [
  "src/main.js",
  "src/preload.js",
  "src/installer/runner.js",
  "src/installer/prerequisites.js",
  "src/installer/codex-environment.js",
  "src/installer/diagnostics.js",
  "src/installer/existing-api-key.js",
  "src/installer/tritonai-connection.js",
  "src/installer/t3code-desktop.js",
  "src/installer/codex-vendor.js",
  "src/installer/npm-policy.js",
  "src/installer/constants.js",
  "src/installer/tool-manifest.js",
  "src/installer/config-writers.js",
  "src/renderer/index.html",
  "src/renderer/app.js",
  "src/renderer/styles.css",
  "electron-builder.mac.json",
  "electron-builder.win.json",
  "build/entitlements.mac.plist",
  "build/entitlements.mac.inherit.plist",
  "build/icon.icns",
  "build/icon.ico",
  "build/icon.png",
  "build/installer.nsh",
  "scripts/verify-npm-age.js",
  "scripts/test-clean-install-dry-run.js",
  "scripts/test-clean-runtime.js",
  "scripts/write-managed-config.js",
  "scripts/verify-macos-bundled-resources.js",
  "scripts/prepare-skills-vendor.js",
  "scripts/prepare-codex-cli-vendor.js",
  "scripts/prepare-t3code-desktop-vendor.js",
  "scripts/prepare-developer-id-csr.js",
  "scripts/import-developer-id-cert.js",
  "scripts/package-macos-release.js",
  "scripts/package-macos-fast-test.js",
  "scripts/serve-macos-release.js",
  "scripts/serve-macos-fast-test.js",
  "scripts/publish-github-release.js",
  "scripts/package-windows-portable.js",
  "scripts/trust-macos-dev-artifacts.js"
];

for (const file of required) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

for (const file of required.filter((file) => file.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "inherit"
  });
}

console.log("Installer scaffold validated.");
