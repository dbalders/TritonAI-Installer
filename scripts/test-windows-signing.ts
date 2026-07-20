const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const {
  assertAuthenticodeResults,
  createSignedWindowsBuilderConfiguration,
  expectedWindowsPublisherName,
  resolveAzureTrustedSigningConfiguration
} = require("./windows-signing");

const completeEnvironment: Record<string, string> = {
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
  AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "ucsd-tritonai",
  AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "tritonai-release",
  AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "University of California San Diego",
  ...Object.fromEntries([["AZURE_CLIENT_SECRET", "test-client-secret"]])
};

function main() {
  assert.strictEqual(expectedWindowsPublisherName, completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME);
  assert.throws(
    () => resolveAzureTrustedSigningConfiguration({}),
    /AZURE_TENANT_ID.*AZURE_TRUSTED_SIGNING_PUBLISHER_NAME/
  );
  try {
    resolveAzureTrustedSigningConfiguration(
      Object.fromEntries([["AZURE_CLIENT_SECRET", completeEnvironment.AZURE_CLIENT_SECRET]])
    );
    assert.fail("Expected incomplete Azure configuration to fail.");
  } catch (error) {
    assert(!String(error.message).includes(completeEnvironment.AZURE_CLIENT_SECRET));
  }
  assert.throws(
    () => resolveAzureTrustedSigningConfiguration({ ...completeEnvironment, AZURE_TRUSTED_SIGNING_ENDPOINT: "http://insecure" }),
    /valid HTTPS URL/
  );
  assert.throws(
    () => resolveAzureTrustedSigningConfiguration({
      ...completeEnvironment,
      AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "Caller Selected Publisher"
    }),
    /must be 'University of California San Diego'/
  );

  const baseConfiguration = JSON.parse(fs.readFileSync(path.join(repoRoot, "electron-builder.win.json"), "utf8"));
  const config = createSignedWindowsBuilderConfiguration(baseConfiguration, completeEnvironment);
  assert.strictEqual(config.forceCodeSigning, true);
  assert.strictEqual(config.win.signAndEditExecutable, true);
  assert.deepStrictEqual(config.win.azureSignOptions, {
    publisherName: completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME,
    endpoint: completeEnvironment.AZURE_TRUSTED_SIGNING_ENDPOINT,
    certificateProfileName: completeEnvironment.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
    codeSigningAccountName: completeEnvironment.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
    fileDigest: "SHA256",
    timestampDigest: "SHA256",
    timestampRfc3161: "http://timestamp.acs.microsoft.com"
  });
  assert(!JSON.stringify(config).includes(completeEnvironment.AZURE_CLIENT_SECRET));

  const expectedPaths = ["C:\\release\\setup.exe", "C:\\release\\portable.exe"];
  const validResults = expectedPaths.map((file) => ({
    path: file,
    status: "Valid",
    publisherName: completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME,
    thumbprint: "ABC123",
    timestampSubject: "CN=Microsoft Time-Stamp Service"
  }));
  assert.strictEqual(
    assertAuthenticodeResults(validResults, expectedPaths, completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME).length,
    2
  );
  assert.throws(
    () => assertAuthenticodeResults(
      [{ ...validResults[0], status: "NotSigned" }, validResults[1]],
      expectedPaths,
      completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME
    ),
    /Invalid Authenticode signature/
  );
  assert.throws(
    () => assertAuthenticodeResults(
      [{ ...validResults[0], publisherName: "Wrong Publisher" }, validResults[1]],
      expectedPaths,
      completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME
    ),
    /publisher mismatch/
  );
  assert.throws(
    () => assertAuthenticodeResults(
      [{ ...validResults[0], timestampSubject: null }, validResults[1]],
      expectedPaths,
      completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME
    ),
    /trusted timestamp is missing/
  );

  const verifier = fs.readFileSync(path.join(repoRoot, "scripts", "verify-windows-authenticode.ps1"), "utf8");
  assert(verifier.includes("Get-AuthenticodeSignature -LiteralPath"));
  assert(verifier.includes("SignatureStatus]::Valid"));
  assert(verifier.includes("$PublisherName -cne $ExpectedPublisherName"));
  assert(verifier.includes("$null -eq $Signature.TimeStamperCertificate"));
  assert(verifier.includes("FromBase64String($EncodedPaths)"));
  const unsignedPortable = fs.readFileSync(path.join(repoRoot, "scripts", "package-windows-portable.ts"), "utf8");
  assert(unsignedPortable.includes('TRITONAI_ALLOW_UNSIGNED_WINDOWS_DEV_BUILD !== "1"'));
  const packageJson = require(path.join(repoRoot, "package.json"));
  assert(!packageJson.scripts["package:win-portable"]);
  assert(packageJson.scripts["package:win-portable:unsigned-dev"]);
  console.log("Windows signing tests passed.");
}

main();
