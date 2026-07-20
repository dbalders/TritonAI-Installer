const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Arch, Platform, build } = require("electron-builder");

const root = path.resolve(__dirname, "..", "..");
const proofRelativePath = "artifacts/windows-installer/authenticode-signatures.json";
const expectedWindowsPublisherName = "University of California San Diego";
const requiredEnvironmentVariables = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"
];

function resolveAzureTrustedSigningConfiguration(environment = process.env) {
  const missing = requiredEnvironmentVariables.filter((name) => !String(environment[name] || "").trim());
  if (missing.length > 0) {
    throw new Error(`Stable Windows packaging requires Azure Trusted Signing configuration: ${missing.join(", ")}.`);
  }

  const endpoint = String(environment.AZURE_TRUSTED_SIGNING_ENDPOINT).trim();
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error("AZURE_TRUSTED_SIGNING_ENDPOINT must be a valid HTTPS URL.");
  }
  if (endpointUrl.protocol !== "https:") {
    throw new Error("AZURE_TRUSTED_SIGNING_ENDPOINT must be a valid HTTPS URL.");
  }

  const publisherName = String(environment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME).trim();
  if (publisherName !== expectedWindowsPublisherName) {
    throw new Error(
      `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME must be '${expectedWindowsPublisherName}'.`
    );
  }

  return {
    publisherName,
    endpoint,
    certificateProfileName: String(environment.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME).trim(),
    codeSigningAccountName: String(environment.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME).trim(),
    fileDigest: String(environment.AZURE_TRUSTED_SIGNING_FILE_DIGEST || "SHA256").trim(),
    timestampDigest: String(environment.AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST || "SHA256").trim(),
    timestampRfc3161: String(
      environment.AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161 || "http://timestamp.acs.microsoft.com"
    ).trim()
  };
}

function createSignedWindowsBuilderConfiguration(baseConfiguration, environment = process.env) {
  const azureSignOptions = resolveAzureTrustedSigningConfiguration(environment);
  return {
    ...baseConfiguration,
    forceCodeSigning: true,
    win: {
      ...baseConfiguration.win,
      signAndEditExecutable: true,
      azureSignOptions
    }
  };
}

function expectedWindowsExecutables(repositoryRoot, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Stable Windows packaging requires a stable semantic version; found ${version}.`);
  }
  return [
    path.join(repositoryRoot, "artifacts", "windows-installer", `TritonAI-Installer-Setup-${version}-x64.exe`),
    path.join(repositoryRoot, "artifacts", "windows-installer", `TritonAI-Installer-${version}-x64-portable.exe`),
    path.join(repositoryRoot, "artifacts", "windows-installer", "win-unpacked", "TritonAI Installer.exe")
  ];
}

function assertAuthenticodeResults(results, expectedPaths, expectedPublisherName) {
  if (!Array.isArray(results)) {
    throw new Error("Authenticode verifier returned an invalid result.");
  }
  const byPath = new Map(results.map((entry) => [path.resolve(entry.path), entry]));
  return expectedPaths.map((expectedPath) => {
    const result = byPath.get(path.resolve(expectedPath));
    if (!result) throw new Error(`Authenticode verifier omitted ${expectedPath}.`);
    if (result.status !== "Valid") {
      throw new Error(`Invalid Authenticode signature for ${expectedPath}: ${result.status}.`);
    }
    if (result.publisherName !== expectedPublisherName) {
      throw new Error(
        `Authenticode publisher mismatch for ${expectedPath}. Expected '${expectedPublisherName}', found '${result.publisherName}'.`
      );
    }
    if (!result.thumbprint) throw new Error(`Authenticode signer certificate is missing for ${expectedPath}.`);
    if (!result.timestampSubject) {
      throw new Error(`Authenticode trusted timestamp is missing for ${expectedPath}.`);
    }
    return result;
  });
}

function verifyWindowsReleaseSignatures({
  repositoryRoot = root,
  version,
  environment = process.env
}) {
  const signing = resolveAzureTrustedSigningConfiguration(environment);
  const executablePaths = expectedWindowsExecutables(repositoryRoot, version);
  const results = verifyAuthenticodeExecutables({
    repositoryRoot,
    executablePaths,
    expectedPublisherName: signing.publisherName
  });

  const proof = {
    schemaVersion: 1,
    version,
    publisherName: signing.publisherName,
    verifiedAt: new Date().toISOString(),
    signatures: results.map((result) => ({
      path: path.relative(repositoryRoot, path.resolve(result.path)).split(path.sep).join("/"),
      sha256: sha256(path.resolve(result.path)),
      status: result.status,
      publisherName: result.publisherName,
      subject: result.subject,
      thumbprint: result.thumbprint,
      timestampSubject: result.timestampSubject
    }))
  };
  const proofPath = path.join(repositoryRoot, proofRelativePath);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  const temporaryPath = `${proofPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, proofPath);
  return { proof, proofPath };
}

function verifyAuthenticodeExecutables({
  repositoryRoot = root,
  executablePaths,
  expectedPublisherName = expectedWindowsPublisherName
}) {
  if (process.platform !== "win32") {
    throw new Error("Authenticode verification must run on Windows.");
  }
  if (expectedPublisherName !== expectedWindowsPublisherName) {
    throw new Error(`Authenticode verification requires publisher '${expectedWindowsPublisherName}'.`);
  }
  if (!Array.isArray(executablePaths) || executablePaths.length === 0) {
    throw new Error("Authenticode verification requires at least one executable.");
  }
  for (const executablePath of executablePaths) {
    if (!fs.existsSync(executablePath) || !fs.lstatSync(executablePath).isFile()) {
      throw new Error(`Missing Windows executable for Authenticode verification: ${executablePath}`);
    }
  }

  const verifier = path.join(repositoryRoot, "scripts", "verify-windows-authenticode.ps1");
  const encodedExecutablePaths = Buffer.from(JSON.stringify(executablePaths), "utf8").toString("base64");
  const stdout = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      verifier,
      "-ExpectedPublisherName",
      expectedPublisherName,
      "-EncodedPaths",
      encodedExecutablePaths
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  return assertAuthenticodeResults(JSON.parse(String(stdout)), executablePaths, expectedPublisherName);
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("Stable Windows packaging must run on Windows.");
  }
  const pkg = require(path.join(root, "package.json"));
  const baseConfiguration = JSON.parse(fs.readFileSync(path.join(root, "electron-builder.win.json"), "utf8"));
  const config = createSignedWindowsBuilderConfiguration(baseConfiguration);

  await build({
    targets: Platform.WINDOWS.createTarget(["nsis", "portable"], Arch.x64),
    config,
    publish: "never"
  });
  const result = verifyWindowsReleaseSignatures({ version: pkg.version });
  console.log(`Windows release signatures verified: ${path.relative(root, result.proofPath)}`);
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
  assertAuthenticodeResults,
  createSignedWindowsBuilderConfiguration,
  expectedWindowsPublisherName,
  expectedWindowsExecutables,
  proofRelativePath,
  requiredEnvironmentVariables,
  resolveAzureTrustedSigningConfiguration,
  verifyAuthenticodeExecutables,
  verifyWindowsReleaseSignatures
};
