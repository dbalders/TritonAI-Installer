const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const required = [
  "runner.ts",
  "test-electron3.ts",
  "src/main.ts",
  "src/install-lifecycle.ts",
  "src/single-instance.ts",
  "src/packaged-boot-smoke.ts",
  "src/preload.ts",
  "src/global.d.ts",
  "src/installer/app-root.ts",
  "src/installer/runner.ts",
  "src/installer/atomic-file.ts",
  "src/installer/directory-transaction.ts",
  "src/installer/process-termination.ts",
  "src/installer/prerequisites.ts",
  "src/installer/install-preflight.ts",
  "src/installer/codex-environment.ts",
  "src/installer/diagnostics.ts",
  "src/installer/installer-version-marker.ts",
  "src/installer/plugin-provenance.ts",
  "src/installer/plugin-bundle-manifest.ts",
  "src/installer/plugins.ts",
  "src/installer/skill-manifest.ts",
  "src/installer/existing-api-key.ts",
  "src/installer/tritonai-connection.ts",
  "src/installer/t3code-desktop.ts",
  "src/installer/windows-publisher-identity.ts",
  "src/installer/codex-vendor.ts",
  "src/installer/npm-policy.ts",
  "src/installer/constants.ts",
  "src/installer/tool-manifest.ts",
  "src/installer/config-writers.ts",
  "src/renderer/index.html",
  "src/renderer/install-progress.ts",
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
  "scripts/test-prerequisites.ts",
  "scripts/test-install-preflight.ts",
  "scripts/test-install-lifecycle.ts",
  "scripts/test-packaged-boot-smoke.ts",
  "scripts/test-installer-version-marker.ts",
  "scripts/test-skills.ts",
  "scripts/test-plugins.ts",
  "scripts/test-windows-upgrade.ts",
  "scripts/test-release-contract.ts",
  "scripts/test-install-transactions.ts",
  "scripts/test-renderer-progress.ts",
  "scripts/test-clean-runtime.ts",
  "scripts/write-managed-config.ts",
  "scripts/verify-macos-bundled-resources.ts",
  "scripts/prepare-skills-vendor.ts",
  "scripts/prepare-plugins-vendor.ts",
  "scripts/prepare-codex-cli-vendor.ts",
  "scripts/prepare-node-runtime-vendor.ts",
  "scripts/prepare-t3code-desktop-vendor.ts",
  "scripts/prepare-developer-id-csr.ts",
  "scripts/import-developer-id-cert.ts",
  "scripts/package-macos-release.ts",
  "scripts/package-macos-fast-test.ts",
  "scripts/serve-macos-release.ts",
  "scripts/serve-macos-fast-test.ts",
  "scripts/publish-github-release.ts",
  "scripts/release-contract.ts",
  "scripts/clean-release-output.ts",
  "scripts/package-windows-portable.ts",
  "scripts/package-windows-unsigned.ts",
  "scripts/verify-windows-unsigned-release.ts",
  "scripts/windows-signing.ts",
  "scripts/verify-windows-authenticode.ps1",
  "scripts/verify-windows-packaged-boot.ps1",
  "scripts/test-windows-signing.ts",
  "scripts/trust-macos-dev-artifacts.ts",
  "tsconfig.json",
  "tsconfig.renderer.json",
  "release-artifacts.json",
  "dist/src/main.js",
  "dist/src/preload.js",
  "dist/src/renderer/app.js",
  "dist/src/renderer/install-progress.js"
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

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const windowsPackageScript = packageJson.scripts?.["package:win-installer"] || "";
const signedWindowsPackageScript = packageJson.scripts?.["package:win-installer:signed"] || "";
const nativeWindowsVerificationScript = packageJson.scripts?.["verify:win-installer:native"] || "";
const explicitPluginPrepareScript = packageJson.scripts?.["prepare:plugins-vendor"] || "";
for (const [name, script, ending] of [
  ["package:win-installer", windowsPackageScript, "node dist/scripts/package-windows-unsigned.js"],
  ["package:win-installer:signed", signedWindowsPackageScript, "node dist/scripts/windows-signing.js"]
]) {
  const buildCount = script.match(/npm run build/g)?.length || 0;
  if (buildCount !== 1) {
    throw new Error(`${name} must compile exactly once; found ${buildCount} build steps.`);
  }
  if (!script.endsWith(ending)) {
    throw new Error(`${name} must end with ${ending}.`);
  }
}
if (!windowsPackageScript.includes("prepare:t3code-desktop-vendor:win:unsigned:compiled")) {
  throw new Error("Current Windows release packaging must explicitly bind the unsigned Harness trust policy.");
}
if (!signedWindowsPackageScript.includes("prepare:t3code-desktop-vendor:win:compiled")) {
  throw new Error("Signed Windows release packaging must explicitly bind the Authenticode Harness trust policy.");
}
if (nativeWindowsVerificationScript !== "npm run build && node dist/scripts/verify-windows-unsigned-release.js") {
  throw new Error("Unsigned Windows native verification must run the exact-candidate verifier.");
}
if (explicitPluginPrepareScript !== "npm run build && npm run prepare:plugins-vendor:compiled --") {
  throw new Error("Explicit plugin preparation must forward release selectors such as --production.");
}

for (const scriptName of [
  "clean:release-output:compiled",
  "prepare:managed-config:compiled",
  "prepare:t3code-desktop-vendor:win:compiled",
  "prepare:t3code-desktop-vendor:win:unsigned:compiled",
  "prepare:codex-cli-vendor:win:compiled",
  "prepare:node-runtime:win:compiled",
  "prepare:skills-vendor:compiled",
  "prepare:plugins-vendor:compiled",
  "prepare:plugins-vendor:latest:compiled"
]) {
  const script = packageJson.scripts?.[scriptName] || "";
  if (!script || script.includes("npm run build")) {
    throw new Error(`${scriptName} must run against the existing compiled output without rebuilding.`);
  }
}

console.log("Installer scaffold validated.");
