const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const required = [
  "runner.ts",
  "test-electron3.ts",
  "src/main.ts",
  "src/preload.ts",
  "src/global.d.ts",
  "src/installer/app-root.ts",
  "src/installer/runner.ts",
  "src/installer/prerequisites.ts",
  "src/installer/codex-environment.ts",
  "src/installer/diagnostics.ts",
  "src/installer/installer-version-marker.ts",
  "src/installer/skill-manifest.ts",
  "src/installer/existing-api-key.ts",
  "src/installer/tritonai-connection.ts",
  "src/installer/t3code-desktop.ts",
  "src/installer/codex-vendor.ts",
  "src/installer/npm-policy.ts",
  "src/installer/constants.ts",
  "src/installer/tool-manifest.ts",
  "src/installer/config-writers.ts",
  "src/renderer/index.html",
  "src/renderer/app.ts",
  "src/renderer/styles.css",
  "electron-builder.mac.json",
  "electron-builder.win.json",
  "build/entitlements.mac.plist",
  "build/entitlements.mac.inherit.plist",
  "build/icon.icns",
  "build/icon.ico",
  "build/icon.png",
  "build/installer.nsh",
  "scripts/verify-npm-age.ts",
  "scripts/test-clean-install-dry-run.ts",
  "scripts/test-installer-version-marker.ts",
  "scripts/test-skills.ts",
  "scripts/test-clean-runtime.ts",
  "scripts/write-managed-config.ts",
  "scripts/verify-macos-bundled-resources.ts",
  "scripts/prepare-skills-vendor.ts",
  "scripts/prepare-codex-cli-vendor.ts",
  "scripts/prepare-t3code-desktop-vendor.ts",
  "scripts/prepare-developer-id-csr.ts",
  "scripts/import-developer-id-cert.ts",
  "scripts/package-macos-release.ts",
  "scripts/package-macos-fast-test.ts",
  "scripts/serve-macos-release.ts",
  "scripts/serve-macos-fast-test.ts",
  "scripts/publish-github-release.ts",
  "scripts/package-windows-portable.ts",
  "scripts/trust-macos-dev-artifacts.ts",
  "tsconfig.json",
  "tsconfig.renderer.json",
  "dist/src/main.js",
  "dist/src/preload.js",
  "dist/src/renderer/app.js"
];

for (const file of required) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const rendererOutput = fs.readFileSync(path.join(root, "dist", "src", "renderer", "app.js"), "utf8");
const commonJsRendererPatterns = [
  /\bObject\.defineProperty\(exports,/,
  /\bexports\.[A-Za-z_$]/,
  /\bmodule\.exports\b/,
  /\brequire\(/
];
if (commonJsRendererPatterns.some((pattern) => pattern.test(rendererOutput))) {
  throw new Error("Compiled renderer contains CommonJS globals that are unavailable with Electron Node integration disabled.");
}

console.log("Installer scaffold validated.");
