const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Arch, Platform, build } = require("electron-builder");
const { getBundledWindowsInstaller } = require("../src/installer/t3code-desktop");
const { assertWindowsArtifactTrustPolicyForFile } = require("../src/installer/windows-artifact-trust");

const root = path.resolve(__dirname, "..", "..");
const proofRelativePath = "artifacts/windows-installer/unsigned-release.json";
const checksumRelativePath = "artifacts/windows-installer/SHA256SUMS-windows-unsigned.txt";

function createUnsignedWindowsBuilderConfiguration(baseConfiguration) {
  return {
    ...baseConfiguration,
    forceCodeSigning: false,
    win: {
      ...baseConfiguration.win,
      signAndEditExecutable: false
    }
  };
}

function assertUnsignedWindowsReleaseEnvironment(environment = process.env) {
  if (environment.TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE !== "1") {
    throw new Error(
      "Unsigned Windows release packaging requires explicit opt-in: set TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE=1. "
      + "The resulting Setup and portable executables may trigger Microsoft Defender SmartScreen."
    );
  }
  const signingInputs = [
    "CSC_LINK",
    "WIN_CSC_LINK",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"
  ].filter((name) => String(environment[name] || "").trim());
  if (signingInputs.length > 0) {
    throw new Error(
      `Unsigned Windows release packaging refuses ambiguous signing configuration: ${signingInputs.join(", ")}.`
    );
  }
}

function unsignedWindowsReleaseArtifacts(repositoryRoot, version) {
  const output = path.join(repositoryRoot, "artifacts", "windows-installer");
  return [
    path.join(output, `TritonAI-Installer-Setup-${version}-x64.exe`),
    path.join(output, `TritonAI-Installer-Setup-${version}-x64.exe.blockmap`),
    path.join(output, `TritonAI-Installer-${version}-x64-portable.exe`),
    path.join(output, "latest.yml")
  ];
}

function writeUnsignedWindowsReleaseProof({ repositoryRoot = root, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) {
    throw new Error(`Unsigned Windows release proof requires a stable semantic version; found ${version}.`);
  }
  const artifactPaths = unsignedWindowsReleaseArtifacts(repositoryRoot, version);
  for (const artifactPath of artifactPaths) {
    if (!fs.existsSync(artifactPath) || !fs.lstatSync(artifactPath).isFile()) {
      throw new Error(`Missing unsigned Windows release artifact: ${artifactPath}`);
    }
  }
  assertPortableExecutable(artifactPaths[0]);
  assertPortableExecutable(artifactPaths[2]);
  const proof = {
    schemaVersion: 1,
    version,
    trustMode: "unsigned",
    warning: "These Windows executables are intentionally unsigned and may trigger Microsoft Defender SmartScreen.",
    generatedAt: new Date().toISOString(),
    artifacts: artifactPaths.map((artifactPath) => ({
      path: path.relative(repositoryRoot, artifactPath).split(path.sep).join("/"),
      size: fs.statSync(artifactPath).size,
      sha256: sha256(artifactPath)
    }))
  };
  const proofPath = path.join(repositoryRoot, proofRelativePath);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  const temporaryPath = `${proofPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, proofPath);
  const checksumPath = path.join(repositoryRoot, checksumRelativePath);
  const checksumTemporaryPath = `${checksumPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    checksumTemporaryPath,
    `${proof.artifacts
      .map((artifact) => `${artifact.sha256}  ${path.basename(artifact.path)}`)
      .join("\n")}\n`,
    "utf8"
  );
  fs.renameSync(checksumTemporaryPath, checksumPath);
  return { checksumPath, proof, proofPath };
}

function verifyUnsignedWindowsReleaseProof({ repositoryRoot = root, version }) {
  const proofPath = path.join(repositoryRoot, proofRelativePath);
  const checksumPath = path.join(repositoryRoot, checksumRelativePath);
  if (!fs.existsSync(proofPath) || !fs.lstatSync(proofPath).isFile()) {
    throw new Error(`Missing unsigned Windows release proof: ${proofPath}`);
  }
  if (!fs.existsSync(checksumPath) || !fs.lstatSync(checksumPath).isFile()) {
    throw new Error(`Missing unsigned Windows checksum manifest: ${checksumPath}`);
  }
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  const expectedPaths = unsignedWindowsReleaseArtifacts(repositoryRoot, version);
  const expectedRelativePaths = expectedPaths.map((artifactPath) =>
    path.relative(repositoryRoot, artifactPath).split(path.sep).join("/")
  );
  if (
    proof?.schemaVersion !== 1 ||
    proof.version !== version ||
    proof.trustMode !== "unsigned" ||
    !Number.isFinite(Date.parse(proof.generatedAt)) ||
    !Array.isArray(proof.artifacts) ||
    proof.artifacts.length !== expectedPaths.length
  ) {
    throw new Error(`Invalid unsigned Windows release proof: ${proofPath}`);
  }
  const byPath = new Map<string, any>(proof.artifacts.map((artifact) => [artifact?.path, artifact]));
  if (byPath.size !== expectedRelativePaths.length) {
    throw new Error("Unsigned Windows release proof contains duplicate or unexpected artifacts.");
  }
  for (let index = 0; index < expectedPaths.length; index += 1) {
    const artifactPath = expectedPaths[index];
    const relativePath = expectedRelativePaths[index];
    const artifact = byPath.get(relativePath);
    if (!artifact || !fs.existsSync(artifactPath) || !fs.lstatSync(artifactPath).isFile()) {
      throw new Error(`Unsigned Windows release proof omits ${relativePath}.`);
    }
    if (artifact.size !== fs.statSync(artifactPath).size || artifact.sha256 !== sha256(artifactPath)) {
      throw new Error(`Unsigned Windows release proof hash does not match ${relativePath}.`);
    }
  }
  if ([...byPath.keys()].some((relativePath) => !expectedRelativePaths.includes(String(relativePath)))) {
    throw new Error("Unsigned Windows release proof contains an unexpected artifact path.");
  }
  assertPortableExecutable(expectedPaths[0]);
  assertPortableExecutable(expectedPaths[2]);
  const expectedChecksums = proof.artifacts
    .map((artifact) => `${artifact.sha256}  ${path.basename(artifact.path)}`)
    .join("\n") + "\n";
  if (fs.readFileSync(checksumPath, "utf8") !== expectedChecksums) {
    throw new Error("Unsigned Windows checksum manifest does not exactly match the release proof.");
  }
  return { checksumPath, proof, proofPath };
}

function assertPortableExecutable(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length || header.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`Windows release artifact has no valid DOS header: ${file}`);
    }
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < header.length || peOffset > fs.statSync(file).size - 4) {
      throw new Error(`Windows release artifact has an invalid PE header offset: ${file}`);
    }
    const signature = Buffer.alloc(4);
    if (fs.readSync(descriptor, signature, 0, signature.length, peOffset) !== signature.length || !signature.equals(Buffer.from("PE\0\0"))) {
      throw new Error(`Windows release artifact has no valid PE signature: ${file}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main() {
  assertUnsignedWindowsReleaseEnvironment();
  if (process.argv.includes("--preflight")) {
    console.log("Unsigned Windows release opt-in and environment verified.");
    return;
  }
  if (process.argv.length > 2) {
    throw new Error(`Unsupported unsigned Windows packaging arguments: ${process.argv.slice(2).join(" ")}`);
  }
  const pkg = require(path.join(root, "package.json"));
  const bundledHarness = getBundledWindowsInstaller({ appRoot: root, resourcesPath: null, arch: "x64" });
  if (!bundledHarness) throw new Error("Unsigned Windows packaging is missing its prepared Harness payload.");
  assertWindowsArtifactTrustPolicyForFile(
    bundledHarness.trustPolicy,
    "unsigned",
    bundledHarness.installerPath
  );
  const baseConfiguration = JSON.parse(fs.readFileSync(path.join(root, "electron-builder.win.json"), "utf8"));
  const config = createUnsignedWindowsBuilderConfiguration(baseConfiguration);
  const previousAutoDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  try {
    await build({
      targets: Platform.WINDOWS.createTarget(["nsis", "portable"], Arch.x64),
      config,
      publish: "never"
    });
  } finally {
    if (previousAutoDiscovery === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
    else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previousAutoDiscovery;
  }
  const proof = writeUnsignedWindowsReleaseProof({ version: pkg.version });
  console.log(`Unsigned Windows release hashes written to ${path.relative(root, proof.proofPath)}`);
  console.log(`Unsigned Windows checksums written to ${path.relative(root, proof.checksumPath)}`);
  console.log("Run npm run verify:win-installer:native on a clean Windows host before release.");
  console.warn("WARNING: Windows release artifacts are unsigned and may trigger Microsoft Defender SmartScreen.");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  assertUnsignedWindowsReleaseEnvironment,
  assertPortableExecutable,
  checksumRelativePath,
  createUnsignedWindowsBuilderConfiguration,
  proofRelativePath,
  unsignedWindowsReleaseArtifacts,
  verifyUnsignedWindowsReleaseProof,
  writeUnsignedWindowsReleaseProof
};
