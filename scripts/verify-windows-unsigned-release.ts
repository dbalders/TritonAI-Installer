const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { verifyUnsignedWindowsReleaseProof } = require("./package-windows-unsigned");
const { expectedWindowsExecutables, verifyWindowsPackagedBoot } = require("./windows-signing");

const root = path.resolve(__dirname, "..", "..");

function verifyUnsignedWindowsReleaseCandidate({
  repositoryRoot = root,
  version,
  platform = process.platform,
  runPackagedBoot = verifyWindowsPackagedBoot
}) {
  if (platform !== "win32") {
    throw new Error("Unsigned Windows candidate verification must run on a clean native Windows host.");
  }
  verifyUnsignedWindowsReleaseProof({ repositoryRoot, version });
  const proofPath = runPackagedBoot({ repositoryRoot, version });
  assertWindowsPackagedBootProof({ repositoryRoot, version, proofPath });
  return proofPath;
}

function assertWindowsPackagedBootProof({ repositoryRoot = root, version, proofPath }) {
  if (!fs.existsSync(proofPath) || !fs.lstatSync(proofPath).isFile()) {
    throw new Error(`Missing Windows packaged boot proof: ${proofPath}`);
  }
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  const [setupPath, portablePath] = expectedWindowsExecutables(repositoryRoot, version);
  const expected = new Map([
    ["windows-portable", portablePath],
    ["windows-setup", setupPath]
  ]);
  if (
    proof?.schemaVersion !== 1 ||
    proof.version !== version ||
    proof.platform !== "windows-x64" ||
    !Number.isFinite(Date.parse(proof.verifiedAt)) ||
    !Array.isArray(proof.candidates) ||
    proof.candidates.length !== expected.size
  ) {
    throw new Error("Invalid Windows packaged boot proof.");
  }
  const candidates = new Map<string, any>(proof.candidates.map((candidate) => [candidate?.id, candidate]));
  if (candidates.size !== expected.size) throw new Error("Windows packaged boot proof has duplicate candidates.");
  for (const [id, artifactPath] of expected) {
    const candidate = candidates.get(id);
    const relativePath = path.relative(repositoryRoot, artifactPath).split(path.sep).join("/");
    if (!candidate || candidate.path !== relativePath || candidate.sha256 !== sha256(artifactPath)) {
      throw new Error(`Windows packaged boot proof does not match ${id}.`);
    }
    const marker = candidate.marker;
    if (
      marker?.schemaVersion !== 1 ||
      marker.productName !== "TritonAI Installer" ||
      marker.version !== version ||
      marker.platform !== "win32" ||
      marker.arch !== "x64" ||
      marker.packaged !== true ||
      !Number.isInteger(marker.healthyForMs) ||
      marker.healthyForMs < 5_000 ||
      !Number.isFinite(Date.parse(marker.readyAt))
    ) {
      throw new Error(`Windows packaged boot proof has an invalid runtime marker for ${id}.`);
    }
  }
  return proof;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  if (process.argv.length > 2) {
    throw new Error(`Unsupported Windows candidate verification arguments: ${process.argv.slice(2).join(" ")}`);
  }
  const pkg = require(path.join(root, "package.json"));
  const proofPath = verifyUnsignedWindowsReleaseCandidate({ version: pkg.version });
  console.log(`Windows packaged boot verified: ${path.relative(root, proofPath)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  assertWindowsPackagedBootProof,
  verifyUnsignedWindowsReleaseCandidate
};
