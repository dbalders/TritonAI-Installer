const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WINDOWS_ARTIFACT_TRUST_FILE = "windows-artifact-trust.json";
const WINDOWS_ARTIFACT_TRUST_MODES = ["authenticode", "unsigned"];

function sha512Base64(file) {
  const hash = crypto.createHash("sha512");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("base64");
}

function assertWindowsArtifactTrustMode(value) {
  if (!WINDOWS_ARTIFACT_TRUST_MODES.includes(value)) {
    throw new Error(
      `Windows Harness trust mode must be one of ${WINDOWS_ARTIFACT_TRUST_MODES.join(", ")}; found ${JSON.stringify(value)}.`
    );
  }
  return value;
}

function createWindowsArtifactTrustPolicy({ mode, version, artifactPath }) {
  assertWindowsArtifactTrustMode(mode);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ""))) {
    throw new Error(`Windows Harness trust policy requires a valid version; found ${JSON.stringify(version)}.`);
  }
  if (!fs.existsSync(artifactPath) || !fs.lstatSync(artifactPath).isFile()) {
    throw new Error(`Windows Harness trust policy artifact is missing: ${artifactPath}`);
  }
  const stat = fs.statSync(artifactPath);
  return {
    schemaVersion: 1,
    mode,
    version,
    artifact: {
      fileName: path.basename(artifactPath),
      size: stat.size,
      sha512: sha512Base64(artifactPath)
    }
  };
}

function validateWindowsArtifactTrustPolicy(raw, expected) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Windows Harness trust policy must be a JSON object.");
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Windows Harness trust policy has unsupported schema version ${JSON.stringify(raw.schemaVersion)}.`);
  }
  assertWindowsArtifactTrustMode(raw.mode);
  if (raw.version !== expected.version) {
    throw new Error(
      `Windows Harness trust policy version mismatch: expected ${expected.version}, found ${JSON.stringify(raw.version)}.`
    );
  }
  const artifact = raw.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("Windows Harness trust policy is missing its artifact binding.");
  }
  for (const field of ["fileName", "size", "sha512"]) {
    if (artifact[field] !== expected.artifact[field]) {
      throw new Error(`Windows Harness trust policy artifact ${field} does not match the bundled release manifest.`);
    }
  }
  return {
    schemaVersion: 1,
    mode: raw.mode,
    version: raw.version,
    artifact: {
      fileName: artifact.fileName,
      size: artifact.size,
      sha512: artifact.sha512
    }
  };
}

function readWindowsArtifactTrustPolicy(policyPath, expected) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read Windows Harness trust policy ${policyPath}: ${error.message}`);
  }
  return validateWindowsArtifactTrustPolicy(raw, expected);
}

function assertWindowsArtifactTrustPolicyForFile(policy, expectedMode, artifactPath) {
  assertWindowsArtifactTrustMode(expectedMode);
  if (policy.mode !== expectedMode) {
    throw new Error(
      `Windows Harness trust policy mode mismatch: packaging requires ${expectedMode}, found ${JSON.stringify(policy.mode)}.`
    );
  }
  const actual = createWindowsArtifactTrustPolicy({
    mode: expectedMode,
    version: policy.version,
    artifactPath
  });
  return validateWindowsArtifactTrustPolicy(policy, {
    version: actual.version,
    artifact: actual.artifact
  });
}

module.exports = {
  WINDOWS_ARTIFACT_TRUST_FILE,
  WINDOWS_ARTIFACT_TRUST_MODES,
  assertWindowsArtifactTrustPolicyForFile,
  assertWindowsArtifactTrustMode,
  createWindowsArtifactTrustPolicy,
  readWindowsArtifactTrustPolicy,
  validateWindowsArtifactTrustPolicy
};
