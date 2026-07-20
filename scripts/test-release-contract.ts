const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const {
  assertReleaseMayBeUpdated,
  assertReleaseSourceIdentity,
  assertWindowsAuthenticodeProof,
  loadReleaseContract,
  requiredReleaseArtifacts,
  writeReleaseChecksumManifest
} = require("./release-contract");
const { expectedWindowsExecutables } = require("./windows-signing");
const {
  activateStagedVendors,
  assertExplicitHarnessSource,
  assertMatchingManifestVersions,
  assertManifestVersion,
  readHarnessSourceEnvironment,
  selectManifestFile
} = require("./prepare-t3code-desktop-vendor");

function verifyFixtureAuthenticode({ executablePaths, expectedPublisherName }) {
  assert.strictEqual(expectedPublisherName, "University of California San Diego");
  assert(Array.isArray(executablePaths) && executablePaths.length > 0);
  return executablePaths.map((executablePath) => {
    assert(fs.lstatSync(executablePath).isFile());
    return {
      path: executablePath,
      status: "Valid",
      publisherName: expectedPublisherName,
      thumbprint: "ABC123",
      timestampSubject: "CN=Microsoft Time-Stamp Service"
    };
  });
}

function writeFixtureChecksumManifest(options) {
  return writeReleaseChecksumManifest({ ...options, verifyAuthenticode: verifyFixtureAuthenticode });
}

function assertFixtureWindowsProof(options) {
  return assertWindowsAuthenticodeProof({ ...options, verifyAuthenticode: verifyFixtureAuthenticode });
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-release-contract-"));
  try {
    const contractPath = path.join(tempRoot, "release-artifacts.json");
    fs.copyFileSync(path.join(repoRoot, "release-artifacts.json"), contractPath);
    const releaseContract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
    for (const field of ["checksumManifest", "windowsAuthenticodeProof"]) {
      for (const unsafePath of ["../outside.json", "C:outside.json", "C:\\outside.json"]) {
        fs.writeFileSync(contractPath, JSON.stringify({ ...releaseContract, [field]: unsafePath }));
        assert.throws(() => loadReleaseContract(tempRoot), /repository-relative/);
      }
    }
    fs.writeFileSync(contractPath, JSON.stringify(releaseContract));
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ version: "0.2.1" }));
    writeHarnessVendorFixture(tempRoot, "mac-arm64", "latest-mac.yml", "dmg", "0.2.1");
    writeHarnessVendorFixture(tempRoot, "win-x64", "latest.yml", "exe", "0.2.1");
    const artifacts = requiredReleaseArtifacts({ root: tempRoot, version: "0.2.1" });
    assert.deepStrictEqual(
      artifacts.map((entry) => entry.fileName),
      [
        "TritonAI-Installer-0.2.1-arm64.dmg",
        "TritonAI-Installer-Setup-0.2.1-x64.exe",
        "TritonAI-Installer-Setup-0.2.1-x64.exe.blockmap",
        "TritonAI-Installer-0.2.1-x64-portable.exe",
        "latest.yml"
      ]
    );
    for (const artifact of artifacts) {
      fs.mkdirSync(path.dirname(artifact.absolutePath), { recursive: true });
      fs.writeFileSync(artifact.absolutePath, `fixture:${artifact.id}\n`);
    }
    const unpackedExecutable = expectedWindowsExecutables(tempRoot, "0.2.1")[2];
    fs.mkdirSync(path.dirname(unpackedExecutable), { recursive: true });
    fs.writeFileSync(unpackedExecutable, "fixture:windows-unpacked\n");
    writeWindowsAuthenticodeProof(tempRoot, "0.2.1", artifacts);

    const result = writeFixtureChecksumManifest({ root: tempRoot, version: "0.2.1" });
    const manifestLines = fs.readFileSync(result.manifestPath, "utf8").trim().split(/\r?\n/);
    assert.strictEqual(manifestLines.length, artifacts.length);
    for (const line of manifestLines) {
      const fileName = line.replace(/^[a-f0-9]{64}\s+/, "");
      assert.strictEqual(fileName, path.basename(fileName), "checksum entries must use basenames, never build-machine paths");
    }
    assert.doesNotThrow(() => assertFixtureWindowsProof({ root: tempRoot, version: "0.2.1" }));
    const extraExecutable = {
      id: "windows-extra",
      platform: "windows-x64",
      relativePath: "artifacts/windows-installer/TritonAI-Installer-Tool-0.2.1-x64.exe",
      absolutePath: path.join(
        tempRoot,
        "artifacts",
        "windows-installer",
        "TritonAI-Installer-Tool-0.2.1-x64.exe"
      )
    };
    fs.writeFileSync(extraExecutable.absolutePath, "fixture:windows-extra\n");
    assert.throws(
      () => assertFixtureWindowsProof({
        root: tempRoot,
        version: "0.2.1",
        artifacts: [...artifacts, extraExecutable]
      }),
      /Windows Authenticode proof omits/
    );
    writeWindowsAuthenticodeProof(tempRoot, "0.2.1", [...artifacts, extraExecutable]);
    assert.doesNotThrow(() => assertFixtureWindowsProof({
      root: tempRoot,
      version: "0.2.1",
      artifacts: [...artifacts, extraExecutable]
    }));
    writeWindowsAuthenticodeProof(tempRoot, "0.2.1", artifacts);
    if (process.platform !== "win32") {
      assert.throws(
        () => assertWindowsAuthenticodeProof({ root: tempRoot, version: "0.2.1" }),
        /Authenticode verification must run on Windows/
      );
    }
    fs.rmSync(unpackedExecutable);
    assert.throws(
      () => assertFixtureWindowsProof({ root: tempRoot, version: "0.2.1" }),
      /Missing Windows executable for Authenticode verification/
    );
    fs.writeFileSync(unpackedExecutable, "fixture:windows-unpacked\n");
    const proofPath = path.join(
      tempRoot,
      "artifacts",
      "windows-installer",
      "authenticode-signatures.json"
    );
    const wrongPublisherProof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    wrongPublisherProof.publisherName = "Caller Selected Publisher";
    fs.writeFileSync(proofPath, JSON.stringify(wrongPublisherProof));
    assert.throws(
      () => assertFixtureWindowsProof({ root: tempRoot, version: "0.2.1" }),
      /Invalid Windows Authenticode verification proof/
    );
    writeWindowsAuthenticodeProof(tempRoot, "0.2.1", artifacts);
    const untimestampedProof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    untimestampedProof.signatures[0].timestampSubject = null;
    fs.writeFileSync(proofPath, JSON.stringify(untimestampedProof));
    assert.throws(
      () => assertFixtureWindowsProof({ root: tempRoot, version: "0.2.1" }),
      /proof is not valid/
    );
    writeWindowsAuthenticodeProof(tempRoot, "0.2.1", artifacts);
    const setupArtifact = artifacts.find((entry) => entry.id === "windows-setup");
    fs.appendFileSync(setupArtifact.absolutePath, "tampered");
    assert.throws(
      () => assertFixtureWindowsProof({ root: tempRoot, version: "0.2.1" }),
      /proof hash does not match/
    );
    fs.writeFileSync(setupArtifact.absolutePath, "fixture:windows-setup\n");
    writeWindowsAuthenticodeProof(tempRoot, "0.2.1", artifacts);

    writeHarnessVendorFixture(tempRoot, "win-x64", "latest.yml", "exe", "0.2.0");
    assert.throws(
      () => writeFixtureChecksumManifest({ root: tempRoot, version: "0.2.1" }),
      /versions must match/
    );
    writeHarnessVendorFixture(tempRoot, "win-x64", "latest.yml", "exe", "0.2.1");

    const macConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "electron-builder.mac.json"), "utf8"));
    const winConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "electron-builder.win.json"), "utf8"));
    assert.strictEqual(macConfig.dmg.artifactName, "TritonAI-Installer-${version}-${arch}.dmg");
    assert.strictEqual(winConfig.win.artifactName, "TritonAI-Installer-Setup-${version}-${arch}.${ext}");
    assert.strictEqual(winConfig.portable.artifactName, "TritonAI-Installer-${version}-${arch}-portable.${ext}");
    assert.strictEqual(macConfig.appId, "edu.ucsd.tritonai.installer");
    assert.strictEqual(winConfig.appId, "edu.ucsd.tritonai.installer");
    const macHarnessResource = macConfig.extraResources.find((resource) => resource.to === "vendor/t3code-desktop/mac-arm64");
    assert(macHarnessResource.filter.includes("tritonai-plugin-composition.json"));
    assert(
      winConfig.files.includes("vendor/t3code-desktop/win-x64/**/*"),
      "Windows Setup and portable electron-builder targets must include the Harness plugin composition proof"
    );
    assert(macConfig.extraResources.some((resource) => resource.to === "managed-plugin-composition.json"));
    assert(winConfig.extraResources.some((resource) => resource.to === "managed-plugin-composition.json"));
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assert(
      packageJson.scripts["package:win-installer"].endsWith("node dist/scripts/windows-signing.js"),
      "Stable Windows packaging must end at the fail-closed signing and Authenticode gate"
    );
    assert(
      packageJson.scripts["package:win-installer"].indexOf("prepare:plugins-vendor:latest:compiled")
        < packageJson.scripts["package:win-installer"].indexOf("prepare:t3code-desktop-vendor:win:compiled"),
      "Windows packaging must resolve the latest stable plugins before accepting a composed Harness release"
    );
    assert.strictEqual(
      packageJson.scripts["prepare:plugins-vendor:latest:compiled"],
      "node dist/scripts/prepare-plugins-vendor.js --latest"
    );
    const macReleaseSource = fs.readFileSync(path.join(repoRoot, "scripts", "package-macos-release.ts"), "utf8");
    assert(
      macReleaseSource.includes('"prepare-plugins-vendor.js"), "--latest"'),
      "macOS release packaging must resolve the latest stable plugins"
    );

    assert.deepStrictEqual(
      readHarnessSourceEnvironment({
        UCSD_HARNESS_VERSION: "0.2.1",
        UCSD_HARNESS_RELEASE_BASE: "file:///legacy"
      }),
      {
        expectedHarnessVersion: "",
        defaultReleaseBase: "",
        macReleaseBase: "",
        winReleaseBase: ""
      },
      "legacy Harness environment aliases must not be accepted"
    );
    assert.deepStrictEqual(
      readHarnessSourceEnvironment({
        TRITONAI_HARNESS_VERSION: "0.2.1",
        TRITONAI_HARNESS_RELEASE_BASE: "file:///canonical"
      }),
      {
        expectedHarnessVersion: "0.2.1",
        defaultReleaseBase: "file:///canonical",
        macReleaseBase: "file:///canonical",
        winReleaseBase: "file:///canonical"
      }
    );

    assert.throws(
      () => assertExplicitHarnessSource({ expectedVersion: "", macReleaseBase: "", winReleaseBase: "", target: "all" }),
      /TRITONAI_HARNESS_VERSION/
    );
    assert.throws(
      () => assertExplicitHarnessSource({ expectedVersion: "0.2.1", macReleaseBase: "", winReleaseBase: "", target: "all" }),
      /TRITONAI_HARNESS_RELEASE_BASE/
    );
    assert.doesNotThrow(() => assertExplicitHarnessSource({
      expectedVersion: "0.2.1",
      macReleaseBase: "file:///release",
      winReleaseBase: "file:///release",
      target: "all"
    }));
    assert.doesNotThrow(() => assertManifestVersion({ version: "0.2.1" }, "0.2.1", "Windows"));
    assert.throws(
      () => assertManifestVersion({ version: "0.2.0" }, "0.2.1", "Windows"),
      /does not match expected 0\.2\.1/
    );
    assert.doesNotThrow(() => assertMatchingManifestVersions(["0.2.1", "0.2.1"]));
    assert.throws(
      () => assertMatchingManifestVersions(["0.2.1", "0.2.0"]),
      /manifest versions must match/
    );
    assert.throws(
      () => selectManifestFile({ files: { "TritonAI-Harness-Preview-0.2.1-x64.exe": {} } }, /^TritonAI-Harness-0\.2\.1-x64\.exe$/),
      /does not include an asset matching/
    );
    assertVendorActivationRollback(tempRoot);

    initializeGitFixture(tempRoot);
    assert.doesNotThrow(() => assertReleaseSourceIdentity({ root: tempRoot, tag: "v0.2.1", version: "0.2.1" }));
    assert.throws(
      () => assertReleaseSourceIdentity({
        root: tempRoot,
        tag: "v0.2.1",
        version: "0.2.1",
        remoteTaggedCommit: "b".repeat(40)
      }),
      /Remote release tag.*but HEAD is/
    );
    assert.throws(
      () => assertReleaseSourceIdentity({ root: tempRoot, tag: "v0.2.0", version: "0.2.1" }),
      /does not match package version/
    );
    assert.throws(
      () => assertReleaseSourceIdentity({ root: tempRoot, tag: "v0.2.0", version: "0.2.0" }),
      /does not match package\.json at HEAD/
    );
    fs.writeFileSync(path.join(tempRoot, "after-tag.txt"), "new HEAD\n");
    git(tempRoot, ["add", "after-tag.txt"]);
    git(tempRoot, ["commit", "-m", "advance head"]);
    assert.throws(
      () => assertReleaseSourceIdentity({ root: tempRoot, tag: "v0.2.1", version: "0.2.1" }),
      /but HEAD is/
    );

    assert.doesNotThrow(() => assertReleaseMayBeUpdated(null));
    assert.doesNotThrow(() => assertReleaseMayBeUpdated({ isDraft: true }));
    assert.throws(() => assertReleaseMayBeUpdated({ isDraft: false }), /existing published GitHub release/);

    fs.rmSync(artifacts[0].absolutePath);
    assert.throws(
      () => writeFixtureChecksumManifest({ root: tempRoot, version: "0.2.1" }),
      /Missing required release artifacts/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("Release contract tests passed.");
}

function writeHarnessVendorFixture(repositoryRoot, target, manifestName, extension, version) {
  const arch = target.split("-")[1];
  const assetName = `TritonAI-Harness-${version}-${arch}.${extension}`;
  const vendorDir = path.join(repositoryRoot, "vendor", "t3code-desktop", target);
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, assetName), "fixture");
  fs.writeFileSync(path.join(vendorDir, manifestName), [
    `version: ${version}`,
    "files:",
    `  - url: ${assetName}`,
    "    sha512: fixture",
    "    size: 7",
    ""
  ].join("\n"));
}

function writeWindowsAuthenticodeProof(repositoryRoot, version, artifacts) {
  const crypto = require("crypto");
  const releaseExecutablePaths = artifacts
    .filter((entry) => entry.platform === "windows-x64" && entry.absolutePath.toLowerCase().endsWith(".exe"))
    .map((entry) => entry.absolutePath);
  const signatures = [...new Set([
    ...releaseExecutablePaths,
    expectedWindowsExecutables(repositoryRoot, version)[2]
  ].map((absolutePath) => path.resolve(absolutePath)))]
    .map((absolutePath) => ({
      relativePath: path.relative(repositoryRoot, absolutePath).split(path.sep).join("/"),
      absolutePath
    }))
    .map((entry) => ({
      path: entry.relativePath,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(entry.absolutePath)).digest("hex"),
      status: "Valid",
      publisherName: "University of California San Diego",
      subject: "CN=University of California San Diego",
      thumbprint: "ABC123",
      timestampSubject: "CN=Microsoft Time-Stamp Service"
    }));
  const proofPath = path.join(repositoryRoot, "artifacts", "windows-installer", "authenticode-signatures.json");
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, JSON.stringify({
    schemaVersion: 1,
    version,
    publisherName: "University of California San Diego",
    verifiedAt: "2026-07-18T00:00:00.000Z",
    signatures
  }));
}

function assertVendorActivationRollback(tempRoot) {
  const stageRoot = path.join(tempRoot, "harness-stages");
  const activeRoot = path.join(tempRoot, "harness-active");
  const stages = ["mac-arm64", "win-x64"].map((target) => {
    const vendorDir = path.join(activeRoot, target);
    const stagingDir = path.join(stageRoot, target);
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, "state"), `old-${target}`);
    fs.writeFileSync(path.join(stagingDir, "state"), `new-${target}`);
    return { vendorDir, stagingDir };
  });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (source === stages[1].stagingDir && destination === stages[1].vendorDir) {
      throw new Error("simulated second-platform activation failure");
    }
    return originalRenameSync(source, destination);
  };
  try {
    assert.throws(
      () => activateStagedVendors(stages),
      /simulated second-platform activation failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  for (const [index, target] of ["mac-arm64", "win-x64"].entries()) {
    assert.strictEqual(
      fs.readFileSync(path.join(stages[index].vendorDir, "state"), "utf8"),
      `old-${target}`,
      "cross-platform vendor activation must roll back both targets"
    );
  }
}

function initializeGitFixture(root) {
  git(root, ["init"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "release source"]);
  git(root, ["tag", "v0.2.1"]);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

main();
