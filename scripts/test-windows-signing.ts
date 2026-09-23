const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const {
  assertAuthenticodeResults,
  createSignedWindowsBuilderConfiguration,
  expectedWindowsPublisherName,
  resolveAzureTrustedSigningConfiguration
} = require("./windows-signing");
const {
  readWindowsTrustMode,
  verifyExpectedWindowsHarnessPublisher: verifyHarnessPublisherBeforeVendoring
} = require("./prepare-t3code-desktop-vendor");
const {
  assertUnsignedWindowsReleaseEnvironment,
  assertPortableExecutable,
  createUnsignedWindowsBuilderConfiguration,
  unsignedWindowsReleaseArtifacts,
  verifyUnsignedWindowsReleaseProof,
  writeWindowsUpdateManifest,
  writeUnsignedWindowsReleaseProof
} = require("./package-windows-unsigned");
const {
  assertWindowsPackagedBootProof,
  verifyUnsignedWindowsReleaseCandidate
} = require("./verify-windows-unsigned-release");
const {
  assertWindowsArtifactTrustPolicyForFile,
  createWindowsArtifactTrustPolicy,
  validateWindowsArtifactTrustPolicy
} = require("../src/installer/windows-artifact-trust");

const completeEnvironment: Record<string, string> = {
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
  AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "ucsd-tritonai",
  AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "tritonai-release",
  AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "The Regents of the University of California",
  ...Object.fromEntries([["AZURE_CLIENT_SECRET", "test-client-secret"]])
};

function main() {
  assertHarnessRunBinding();
  assertUnsignedReleaseContract();
  assert.strictEqual(expectedWindowsPublisherName, completeEnvironment.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME);
  assert.throws(
    () => resolveAzureTrustedSigningConfiguration({}),
    /AZURE_TENANT_ID.*AZURE_TRUSTED_SIGNING_PUBLISHER_NAME/
  );
  assert.throws(
    () => resolveAzureTrustedSigningConfiguration(
      Object.fromEntries([["AZURE_CLIENT_SECRET", completeEnvironment.AZURE_CLIENT_SECRET]])
    ),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert(!message.includes(completeEnvironment.AZURE_CLIENT_SECRET));
      return /Stable Windows packaging requires Azure Trusted Signing configuration/.test(message);
    }
  );
  assert.throws(
    () => resolveAzureTrustedSigningConfiguration({ ...completeEnvironment, AZURE_TRUSTED_SIGNING_ENDPOINT: "http://insecure" }),
    /valid HTTPS URL/
  );
  assert.throws(
    () => resolveAzureTrustedSigningConfiguration({
      ...completeEnvironment,
      AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "Caller Selected Publisher"
    }),
    /must be 'The Regents of the University of California'/
  );

  const oidcEnvironment = { ...completeEnvironment, AZURE_CLIENT_SECRET: "", AZURE_TRUSTED_SIGNING_USE_AZURE_CLI: "true" };
  assert.deepStrictEqual(resolveAzureTrustedSigningConfiguration(oidcEnvironment), resolveAzureTrustedSigningConfiguration(completeEnvironment));
  assert.throws(() => resolveAzureTrustedSigningConfiguration({ ...oidcEnvironment, AZURE_TRUSTED_SIGNING_USE_AZURE_CLI: "false" }), /AZURE_CLIENT_SECRET/);
  assert.throws(() => resolveAzureTrustedSigningConfiguration({ ...oidcEnvironment, AZURE_TRUSTED_SIGNING_USE_AZURE_CLI: "yes" }), /must be true or false/);
  assert.throws(() => resolveAzureTrustedSigningConfiguration({ ...completeEnvironment, AZURE_TRUSTED_SIGNING_USE_AZURE_CLI: "true" }), /refuses AZURE_CLIENT_SECRET/);

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
  const packagedBoot = fs.readFileSync(path.join(repoRoot, "scripts", "verify-windows-packaged-boot.ps1"), "utf8");
  assert(packagedBoot.includes("Refusing to replace an existing TritonAI Installer"));
  assert(packagedBoot.includes("Invoke-PackagedBoot $PortablePath"));
  assert(packagedBoot.includes("Invoke-PackagedBoot $InstalledExecutable"));
  assert(packagedBoot.includes("Get-FileHash -LiteralPath"));
  assert(packagedBoot.includes("Wait-ForPathState $ExpectedInstalledDirectory $false"));
  assert(packagedBoot.includes("Wait-ForOwnedProcess $SetupProcess $SetupTimeoutMilliseconds"));
  assert(packagedBoot.includes("Wait-ForOwnedProcess $Cleanup $UninstallTimeoutMilliseconds"));
  assert(packagedBoot.includes('Wait-ForOwnedProcess $Process $TerminationTimeoutMilliseconds "$CandidateId packaged boot"'));
  assert(packagedBoot.includes("exited with code $($Process.ExitCode) before writing its packaged boot readiness marker"));
  assert(packagedBoot.includes("Stop-Process -Id $TimedOutPid -Force"));
  assert(!packagedBoot.includes('Start-Process -FilePath $SetupPath -ArgumentList "/S" -Wait'));
  assert(packagedBoot.includes('$ExpectedInstalledDirectory = Join-Path $env:LOCALAPPDATA "Programs\\$ProductName"'));
  assert(packagedBoot.includes("Refusing to replace an existing unregistered TritonAI Installer directory"));
  assert(packagedBoot.includes("Remove-Item -LiteralPath $ExpectedInstalledDirectory -Recurse -Force"));
  assert(packagedBoot.includes('$SetupArguments = @("/S", "/D=$ExpectedInstalledDirectory")'));
  assert(packagedBoot.includes("Start-Process -FilePath $SetupPath -ArgumentList $SetupArguments -PassThru"));
  const fixtureHarnessPath = path.join(repoRoot, "fixture-harness.exe");
  assert.throws(
    () => verifyHarnessPublisherBeforeVendoring(fixtureHarnessPath, { platform: "darwin" }),
    /must run on Windows/
  );
  const verifiedHarness = verifyHarnessPublisherBeforeVendoring(fixtureHarnessPath, {
    platform: "win32",
    execute: (command, args) => {
      assert.strictEqual(command, "pwsh.exe");
      assert(args.includes("-ExpectedPublisherName"));
      assert(args.includes("The Regents of the University of California"));
      return JSON.stringify([{
        path: fixtureHarnessPath,
        status: "Valid",
        publisherName: "The Regents of the University of California",
        thumbprint: "ABC123",
        timestampSubject: "CN=Trusted Timestamp"
      }]);
    }
  });
  assert.strictEqual(verifiedHarness.path, fixtureHarnessPath);
  assert.throws(
    () => verifyHarnessPublisherBeforeVendoring(fixtureHarnessPath, {
      platform: "win32",
      execute: () => JSON.stringify([{
        path: fixtureHarnessPath,
        status: "Valid",
        publisherName: "Wrong Publisher",
        thumbprint: "ABC123",
        timestampSubject: "CN=Trusted Timestamp"
      }])
    }),
    /invalid evidence/
  );
  if (process.platform === "win32") {
    // Exercise the security module in the same nested host used by packaging.
    // Windows PowerShell 5.1 cannot load the inherited PowerShell 7 modules.
    execFileSync("pwsh.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $signature=Get-AuthenticodeSignature -LiteralPath (Join-Path $PSHOME 'pwsh.exe'); if ($signature.Status -ne 'Valid') { throw 'PowerShell Authenticode verification failed' }"
    ], { stdio: "inherit" });
    for (const scriptName of ["verify-windows-authenticode.ps1", "verify-windows-packaged-boot.ps1"]) {
      const scriptPath = path.join(repoRoot, "scripts", scriptName);
      execFileSync("pwsh.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:TRITONAI_PS_PARSE_TARGET,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
      ], {
        stdio: "inherit",
        env: { ...process.env, TRITONAI_PS_PARSE_TARGET: scriptPath }
      });
    }
  }
  console.log("Windows signing tests passed.");
}

function assertUnsignedReleaseContract() {
  assert.throws(() => assertUnsignedWindowsReleaseEnvironment({}), /explicit opt-in/);
  assert.doesNotThrow(() => assertUnsignedWindowsReleaseEnvironment({
    TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE: "1"
  }));
  assert.throws(
    () => assertUnsignedWindowsReleaseEnvironment({
      TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE: "1",
      CSC_LINK: "certificate-material"
    }),
    (error) => {
      assert(!error.message.includes("certificate-material"));
      return /ambiguous signing configuration: CSC_LINK/.test(error.message);
    }
  );
  const baseConfiguration = { win: { target: ["nsis", "portable"], signAndEditExecutable: true } };
  const unsignedConfiguration = createUnsignedWindowsBuilderConfiguration(baseConfiguration);
  assert.strictEqual(unsignedConfiguration.forceCodeSigning, false);
  assert.strictEqual(unsignedConfiguration.win.signAndEditExecutable, false);

  assert.strictEqual(readWindowsTrustMode([]), "authenticode");
  assert.strictEqual(readWindowsTrustMode(["--windows-trust-mode", "unsigned"]), "unsigned");
  assert.throws(
    () => readWindowsTrustMode(["--windows-trust-mode", "unsigned", "--extra"]),
    /exactly one mode/
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-unsigned-windows-proof-"));
  try {
    const version = "0.2.1";
    const artifactPaths = unsignedWindowsReleaseArtifacts(tempRoot, version);
    for (const [index, artifactPath] of artifactPaths.entries()) {
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      if (index === 3) continue;
      if (index === 0 || index === 2) writePeFixture(artifactPath);
      else fs.writeFileSync(artifactPath, `fixture:${path.basename(artifactPath)}`);
    }
    const releaseDate = "2026-08-12T07:30:00.000Z";
    assert.strictEqual(writeWindowsUpdateManifest({
      repositoryRoot: tempRoot,
      version,
      releaseDate
    }), artifactPaths[3]);
    const setupBytes = fs.readFileSync(artifactPaths[0]);
    const setupSha512 = require("crypto").createHash("sha512").update(setupBytes).digest("base64");
    assert.strictEqual(fs.readFileSync(artifactPaths[3], "utf8"), [
      `version: ${version}`,
      "files:",
      `  - url: ${path.basename(artifactPaths[0])}`,
      `    sha512: ${setupSha512}`,
      `    size: ${setupBytes.length}`,
      `path: ${path.basename(artifactPaths[0])}`,
      `sha512: ${setupSha512}`,
      `releaseDate: '${releaseDate}'`,
      ""
    ].join("\n"));
    const result = writeUnsignedWindowsReleaseProof({ repositoryRoot: tempRoot, version });
    assert.strictEqual(result.proof.trustMode, "unsigned");
    assert.strictEqual(result.proof.artifacts.length, 4);
    assert(result.proof.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
    const checksumLines = fs.readFileSync(result.checksumPath, "utf8").trim().split(/\r?\n/);
    assert.strictEqual(checksumLines.length, 4);
    assert(checksumLines.every((line) => /^[a-f0-9]{64}  [^/\\]+$/.test(line)));
    assert.doesNotThrow(() => verifyUnsignedWindowsReleaseProof({ repositoryRoot: tempRoot, version }));
    assert.doesNotThrow(() => assertPortableExecutable(artifactPaths[0]));
    assert.throws(
      () => verifyUnsignedWindowsReleaseCandidate({ repositoryRoot: tempRoot, version, platform: "darwin" }),
      /clean native Windows host/
    );
    const bootProofPath = path.join(tempRoot, "artifacts", "windows-installer", "packaged-boot.json");
    const marker = {
      schemaVersion: 1,
      productName: "TritonAI Installer",
      version,
      platform: "win32",
      arch: "x64",
      packaged: true,
      healthyForMs: 5000,
      readyAt: new Date().toISOString()
    };
    const runPackagedBoot = () => {
      fs.writeFileSync(bootProofPath, `${JSON.stringify({
        schemaVersion: 1,
        version,
        platform: "windows-x64",
        verifiedAt: new Date().toISOString(),
        candidates: [
          {
            id: "windows-portable",
            path: path.relative(tempRoot, artifactPaths[2]).split(path.sep).join("/"),
            sha256: hashFile(artifactPaths[2]),
            marker
          },
          {
            id: "windows-setup",
            path: path.relative(tempRoot, artifactPaths[0]).split(path.sep).join("/"),
            sha256: hashFile(artifactPaths[0]),
            marker
          }
        ]
      }, null, 2)}\n`);
      return bootProofPath;
    };
    assert.strictEqual(
      verifyUnsignedWindowsReleaseCandidate({
        repositoryRoot: tempRoot,
        version,
        platform: "win32",
        runPackagedBoot
      }),
      bootProofPath
    );
    assert.doesNotThrow(() => assertWindowsPackagedBootProof({ repositoryRoot: tempRoot, version, proofPath: bootProofPath }));
    fs.appendFileSync(artifactPaths[2], "tampered");
    assert.throws(
      () => verifyUnsignedWindowsReleaseProof({ repositoryRoot: tempRoot, version }),
      /proof hash does not match/
    );
    writePeFixture(artifactPaths[2]);
    writeUnsignedWindowsReleaseProof({ repositoryRoot: tempRoot, version });

    const harnessPath = path.join(tempRoot, "TritonAI-Harness-0.2.1-x64.exe");
    fs.writeFileSync(harnessPath, "fixture:harness");
    const policy = createWindowsArtifactTrustPolicy({
      mode: "unsigned",
      version,
      artifactPath: harnessPath
    });
    assert.deepStrictEqual(validateWindowsArtifactTrustPolicy(policy, {
      version,
      artifact: policy.artifact
    }), policy);
    assert.deepStrictEqual(
      assertWindowsArtifactTrustPolicyForFile(policy, "unsigned", harnessPath),
      policy
    );
    assert.throws(
      () => assertWindowsArtifactTrustPolicyForFile(policy, "authenticode", harnessPath),
      /mode mismatch/
    );
    fs.appendFileSync(harnessPath, "tampered");
    assert.throws(
      () => assertWindowsArtifactTrustPolicyForFile(policy, "unsigned", harnessPath),
      /artifact size does not match/
    );
    assert.throws(
      () => validateWindowsArtifactTrustPolicy({ ...policy, mode: "caller-selected" }, {
        version,
        artifact: policy.artifact
      }),
      /trust mode must be one of/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertHarnessRunBinding() {
  const { verifyHarnessRunArtifacts } = require("./verify-harness-run-artifacts");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-run-binding-"));
  const runDir = path.join(temp, "run");
  const stagedDir = path.join(temp, "staged");
  fs.mkdirSync(runDir);
  fs.mkdirSync(stagedDir);
  const names = [
    ["latest.yml", "latest.yml"],
    ["TritonAI-Harness-0.3.4-x64.exe", "TritonAI-Harness-0.3.4-x64.exe"],
    ["tritonai-plugin-composition-win-x64.json", "tritonai-plugin-composition.json"]
  ];
  try {
    for (const [runName, stagedName] of names) {
      fs.writeFileSync(path.join(runDir, runName), "approved bytes");
      fs.writeFileSync(path.join(stagedDir, stagedName), "approved bytes");
    }
    assert.strictEqual(verifyHarnessRunArtifacts(runDir, stagedDir, "0.3.4").length, 3);
    for (const [runName, stagedName] of names) {
      // Same-size replacements still fail the byte-level binding.
      fs.writeFileSync(path.join(stagedDir, stagedName), "replaced bytes");
      assert.throws(() => verifyHarnessRunArtifacts(runDir, stagedDir, "0.3.4"), /differs from the selected successful run/);
      fs.copyFileSync(path.join(runDir, runName), path.join(stagedDir, stagedName));
    }
    fs.rmSync(path.join(runDir, "latest.yml"));
    assert.throws(() => verifyHarnessRunArtifacts(runDir, stagedDir, "0.3.4"), /Missing regular Harness run-binding input/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function writePeFixture(file) {
  const data = Buffer.alloc(132);
  data.write("MZ", 0, "ascii");
  data.writeUInt32LE(128, 0x3c);
  data.write("PE\0\0", 128, "binary");
  fs.writeFileSync(file, data);
}

function hashFile(file) {
  return require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

main();
