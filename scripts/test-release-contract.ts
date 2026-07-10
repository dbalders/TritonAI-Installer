const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const {
  assertReleaseMayBeUpdated,
  assertReleaseSourceIdentity,
  requiredReleaseArtifacts,
  writeReleaseChecksumManifest
} = require("./release-contract");
const {
  activateStagedVendors,
  assertExplicitHarnessSource,
  assertMatchingManifestVersions,
  assertManifestVersion,
  readHarnessSourceEnvironment,
  selectManifestFile
} = require("./prepare-t3code-desktop-vendor");

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-release-contract-"));
  try {
    fs.copyFileSync(path.join(repoRoot, "release-artifacts.json"), path.join(tempRoot, "release-artifacts.json"));
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

    const result = writeReleaseChecksumManifest({ root: tempRoot, version: "0.2.1" });
    const manifestLines = fs.readFileSync(result.manifestPath, "utf8").trim().split(/\r?\n/);
    assert.strictEqual(manifestLines.length, artifacts.length);
    for (const line of manifestLines) {
      const fileName = line.replace(/^[a-f0-9]{64}\s+/, "");
      assert.strictEqual(fileName, path.basename(fileName), "checksum entries must use basenames, never build-machine paths");
    }

    writeHarnessVendorFixture(tempRoot, "win-x64", "latest.yml", "exe", "0.2.0");
    assert.throws(
      () => writeReleaseChecksumManifest({ root: tempRoot, version: "0.2.1" }),
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
      () => writeReleaseChecksumManifest({ root: tempRoot, version: "0.2.1" }),
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
