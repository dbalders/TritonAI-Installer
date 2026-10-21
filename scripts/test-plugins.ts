const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertCanonicalPluginRepository, CANONICAL_PLUGIN_REPOSITORY_URL } = require("../src/installer/plugin-provenance");
const { assertArtifactBinding, assertMatchingPluginComposition, isSafeRelativePath, validateManagedPluginBundleManifest } = require("../src/installer/plugin-bundle-manifest");
const { findBundledPluginComposition, inspectBundledPluginComposition, readPluginCompositionRequirement } = require("../src/installer/plugins");
const { pluginCompositionFile, publishedPluginCompositionFile, verifyPluginCompositionProof, downloadAndVerifyPluginComposition, activatePreparedVendors, markLocalReleaseCandidate } = require("./prepare-t3code-desktop-vendor");

function compositionFixture() {
  return {
    version: 1,
    kind: "tritonai-harness-plugin-composition",
    source: { repository: CANONICAL_PLUGIN_REPOSITORY_URL, ref: "refs/tags/v0.1.15", commit: "a".repeat(40) },
    packages: [{ id: "alpha-reader", name: "@tritonai/plugin-alpha-reader", version: "1.0.0", digest: "b".repeat(64),
      files: [{ path: ".tritonai-plugin/plugin.json", sha256: "c".repeat(64), size: 42 }] }]
  };
}

function assertSafeCompositionPaths() {
  for (const relative of ["dist/index.js", ".tritonai-plugin/plugin.json", "skills/graph/SKILL.md"]) {
    assert.strictEqual(isSafeRelativePath(relative), true);
  }
  for (const unsafe of ["../escape", "dist/../escape", "/absolute", "C:/absolute", "dist\\index.js", "dist//index.js", "./package.json"] ) {
    assert.strictEqual(isSafeRelativePath(unsafe), false, unsafe);
  }
}


function assertCanonicalProvenance() {
  for (const repository of [
    CANONICAL_PLUGIN_REPOSITORY_URL,
    "ssh://git@github.com/dbalders/TritonAI-Plugins.git",
    "git@github.com:dbalders/TritonAI-Plugins.git"
  ]) {
    assert.strictEqual(assertCanonicalPluginRepository(repository), "dbalders/TritonAI-Plugins");
  }
  for (const repository of [
    "https://github.com/dbalders/TritonAI-Plugin.git",
    "https://github.com.evil.example/dbalders/TritonAI-Plugins.git",
    "https://gitlab.com/dbalders/TritonAI-Plugins.git",
    "file:///tmp/TritonAI-Plugins",
    "/tmp/TritonAI-Plugins"
  ]) {
    assert.throws(() => assertCanonicalPluginRepository(repository), /not accepted as managed plugin provenance/);
  }
  assert.throws(
    () => assertCanonicalPluginRepository("https://secret@github.com/dbalders/TritonAI-Plugins.git?token=private"),
    (error) => !error.message.includes("secret") && !error.message.includes("private")
  );
  assert.throws(
    () => assertCanonicalPluginRepository("https://build-token@github.com:bad/dbalders/TritonAI-Plugins.git"),
    (error) => !error.message.includes("build-token") && error.message.includes("invalid-repository-url")
  );
}


function assertCompositionContract() {
  withTempRoot("tritonai-plugin-composition-", (tempRoot) => {
    const expected = compositionFixture();
    assert.deepStrictEqual(assertMatchingPluginComposition(expected, structuredClone(expected)), expected);
    const reordered = reverseObjectKeys(expected);
    assert.deepStrictEqual(
      assertMatchingPluginComposition(expected, reordered),
      reordered,
      "composition matching must ignore JSON object key order at every schema level"
    );
    const artifact = {
      fileName: "TritonAI-Harness-0.2.7-arm64.dmg",
      sha512: `${"A".repeat(86)}==`,
      size: 1234
    };
    const bound = { ...structuredClone(expected), artifacts: [artifact] };
    assert.deepStrictEqual(assertMatchingPluginComposition(expected, bound), bound);
    assert.deepStrictEqual(assertArtifactBinding(bound, artifact), artifact);
    assert.throws(
      () => assertArtifactBinding(bound, { ...artifact, size: artifact.size + 1 }),
      /not bound to the exact/
    );
    const legacyRange = structuredClone(expected);
    legacyRange.packages[0]["compatibility"] = { harness: { min: "0.3.0", maxExclusive: "0.4.0" } };
    assert.throws(() => validateManagedPluginBundleManifest(legacyRange), /unsupported fields/);
    const drifted = structuredClone(expected);
    drifted.packages[0].version = "1.0.1";
    assert.throws(() => assertMatchingPluginComposition(expected, drifted), /does not match the exact prepared/);
  });
}


function assertPlatformSpecificProofContract() {
  withTempRoot("tritonai-platform-proofs-", (tempRoot) => {
    const releaseDir = path.join(tempRoot, "release");
    const expected = compositionFixture();
    fs.mkdirSync(releaseDir, { recursive: true });

    const targets = [
      { platform: "mac", arch: "arm64", extension: "dmg" },
      { platform: "win", arch: "x64", extension: "exe" }
    ];
    for (const target of targets) {
      const artifactPath = path.join(
        releaseDir,
        `TritonAI-Harness-0.3.0-${target.arch}.${target.extension}`
      );
      fs.writeFileSync(artifactPath, `final signed ${target.platform} artifact bytes`);
      const binding = artifactBinding(artifactPath);
      const proofName = publishedPluginCompositionFile(target.platform, target.arch);
      const proofPath = path.join(releaseDir, proofName);
      fs.writeFileSync(proofPath, JSON.stringify({ ...expected, artifacts: [binding] }));

      assert.deepStrictEqual(
        verifyPluginCompositionProof({
          proofPath,
          harnessVersion: "0.3.0",
          artifactPath,
          expectedArtifact: binding
        }).artifacts,
        [binding],
        `${target.platform} vendoring must accept its published proof`
      );

      fs.appendFileSync(artifactPath, "\npost-proof mutation");
      assert.throws(
        () => verifyPluginCompositionProof({
          proofPath,
          harnessVersion: "0.3.0",
          artifactPath,
          expectedArtifact: artifactBinding(artifactPath)
        }),
        /not bound to the exact/,
        "signing, notarization, or stapling after proof generation must invalidate the proof"
      );
    }

    assert.strictEqual(pluginCompositionFile, "tritonai-plugin-composition.json");
    assert.strictEqual(
      publishedPluginCompositionFile("mac", "arm64"),
      "tritonai-plugin-composition-mac-arm64.json"
    );
    assert.strictEqual(
      publishedPluginCompositionFile("win", "x64"),
      "tritonai-plugin-composition-win-x64.json"
    );
  });
}


function artifactBinding(artifactPath) {
  return {
    fileName: path.basename(artifactPath),
    size: fs.statSync(artifactPath).size,
    sha512: crypto.createHash("sha512").update(fs.readFileSync(artifactPath)).digest("base64")
  };
}


function assertPackagedResourceInspection() {
  withTempRoot("tritonai-plugin-resource-", (tempRoot) => {
    const resourcesPath = path.join(tempRoot, "resources");
    assert.throws(
      () => readPluginCompositionRequirement({ resourcesPath, appRoot: tempRoot, required: true }),
      /missing managed-plugin-composition.json/
    );
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, "managed-plugin-composition.json"), JSON.stringify({ version: 1, required: true }));
    assert.strictEqual(readPluginCompositionRequirement({ resourcesPath, appRoot: tempRoot, required: true }), true);
    const manifest = compositionFixture();
    const compositionPath = path.join(resourcesPath, "vendor", "t3code-desktop", "mac-arm64", "tritonai-plugin-composition.json");
    const artifactPath = path.join(path.dirname(compositionPath), "TritonAI-Harness-0.2.7-arm64.dmg");
    fs.mkdirSync(path.dirname(compositionPath), { recursive: true });
    fs.writeFileSync(artifactPath, "bound harness artifact");
    const artifact = {
      fileName: path.basename(artifactPath),
      size: fs.statSync(artifactPath).size,
      sha512: require("crypto").createHash("sha512").update(fs.readFileSync(artifactPath)).digest("base64")
    };
    const boundManifest = { ...manifest, artifacts: [artifact] };
    fs.writeFileSync(compositionPath, JSON.stringify(boundManifest));
    assert.strictEqual(findBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot }), compositionPath);
    const originalReadFile = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (file === artifactPath) throw new Error("artifact hashing must not buffer the entire release artifact");
      return originalReadFile(file, ...args);
    };
    try {
      assert.deepStrictEqual(inspectBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot, required: true }), boundManifest);
    } finally {
      fs.readFileSync = originalReadFile;
    }
    fs.writeFileSync(artifactPath, "tampered harness artifact");
    assert.throws(
      () => inspectBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot, required: true }),
      /not bound to the exact/
    );
    fs.rmSync(artifactPath);
    fs.rmSync(compositionPath);
    assert.throws(
      () => inspectBundledPluginComposition({ platform: "darwin", arch: "arm64", resourcesPath, appRoot: tempRoot, required: true }),
      /cannot be verified/
    );
  });
}


function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)])
  );
}


function withTempRoot(prefix, callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { callback(tempRoot); }
  finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
}

function assertPublishedProofConsumption() {
  withTempRoot("tritonai-published-composition-", (tempRoot) => {
    const release = path.join(tempRoot, "release");
    const staging = path.join(tempRoot, "stage");
    fs.mkdirSync(release); fs.mkdirSync(staging);
    const artifactPath = path.join(staging, "TritonAI-Harness-0.3.7-arm64.dmg");
    fs.writeFileSync(artifactPath, "published Harness artifact");
    const binding = artifactBinding(artifactPath);
    const proof = { ...compositionFixture(), artifacts: [binding] };
    const publishedName = publishedPluginCompositionFile("mac", "arm64");
    const source = path.join(release, publishedName);
    const proofPath = path.join(staging, pluginCompositionFile);
    const verify = () => verifyPluginCompositionProof({ proofPath, harnessVersion: "0.3.7", artifactPath, expectedArtifact: binding });
    const download = () => downloadAndVerifyPluginComposition(require("node:url").pathToFileURL(release).href,
      staging, "0.3.7", artifactPath, binding, publishedName);
    assert.throws(download, /does not publish the required/);
    fs.writeFileSync(source, JSON.stringify(proof));
    assert.deepStrictEqual(download(), proof, "published schema-v1 proofs work without a local Plugins checkout or catalog");
    for (const mutate of [
      (p) => { p.source.repository = "https://github.com/attacker/TritonAI-Plugins.git"; },
      (p) => { p.source.commit = "main"; },
      (p) => { p.packages[0].files[0].path = "../escape"; },
      (p) => { p.packages[0].files[0].sha256 = "invalid"; },
      (p) => { p.packages.push(p.packages[0]); },
      (p) => { p.packages[0].unreviewed = true; },
      (p) => { p.artifacts = undefined; },
      (p) => { p.artifacts[0].fileName = "TritonAI-Harness-0.3.6-arm64.dmg"; }
    ]) {
      const invalid = structuredClone(proof); mutate(invalid);
      fs.writeFileSync(proofPath, JSON.stringify(invalid));
      assert.throws(verify);
    }
    fs.writeFileSync(proofPath, "{broken");
    assert.throws(verify, /not valid JSON/);
    fs.writeFileSync(proofPath, JSON.stringify(proof));
    fs.appendFileSync(artifactPath, "tampered");
    assert.throws(verify, /no longer matches its Harness release manifest/);
  });
}

function assertAtomicProofActivation() {
  withTempRoot("tritonai-proof-activation-", (tempRoot) => {
    const requirementPath = path.join(tempRoot, "build", "managed-plugin-composition.generated.json");
    fs.mkdirSync(path.dirname(requirementPath));
    const previousMarker = '{"version":1,"required":false}\n';
    fs.writeFileSync(requirementPath, previousMarker);
    const stages = ["mac-arm64", "win-x64"].map((target) => {
      const stagingDir = path.join(tempRoot, `stage-${target}`);
      const vendorDir = path.join(tempRoot, `vendor-${target}`);
      fs.mkdirSync(stagingDir); fs.mkdirSync(vendorDir);
      fs.writeFileSync(path.join(vendorDir, "previous"), target);
      fs.writeFileSync(path.join(stagingDir, pluginCompositionFile), JSON.stringify(compositionFixture()));
      return { stagingDir, vendorDir };
    });
    const winProof = path.join(stages[1].stagingDir, pluginCompositionFile);
    const different = compositionFixture(); different.source.commit = "d".repeat(40);
    fs.writeFileSync(winProof, JSON.stringify(different));
    assert.throws(() => activatePreparedVendors(stages, requirementPath), /does not match the exact/);
    for (const stage of stages) assert(fs.existsSync(path.join(stage.vendorDir, "previous")));
    assert.strictEqual(fs.readFileSync(requirementPath, "utf8"), previousMarker);
    fs.writeFileSync(winProof, JSON.stringify(compositionFixture()));

    // Fail after both platform payloads move, while activating the required-proof marker.
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target === requirementPath && path.basename(source) === "requirement.json") throw new Error("injected marker activation failure");
      return rename(source, target);
    };
    try { assert.throws(() => activatePreparedVendors(stages, requirementPath), /injected marker/); }
    finally { fs.renameSync = rename; }
    for (const stage of stages) assert(fs.existsSync(path.join(stage.vendorDir, "previous")));
    assert.strictEqual(fs.readFileSync(requirementPath, "utf8"), previousMarker);

    // Recreate staging payloads after rollback, then commit the entire generation.
    for (const stage of stages) {
      fs.mkdirSync(stage.stagingDir);
      fs.writeFileSync(path.join(stage.stagingDir, pluginCompositionFile), JSON.stringify(compositionFixture()));
    }
    activatePreparedVendors(stages, requirementPath);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(requirementPath, "utf8")), { version: 1, required: true });
    for (const stage of stages) {
      assert(!fs.existsSync(path.join(stage.vendorDir, "previous")));
      assert(fs.existsSync(path.join(stage.vendorDir, pluginCompositionFile)));
    }
  });
}

function assertCandidatePublicationMarker() {
  withTempRoot("tritonai-consumer-candidate-", (tempRoot) => {
    assert.strictEqual(markLocalReleaseCandidate({}, tempRoot), null);
    const catalog = path.join(tempRoot, "frozen-catalog.json");
    fs.writeFileSync(catalog, "frozen controller input");
    for (const env of [
      { TRITONAI_LOCAL_RELEASE_CANDIDATE: "1" },
      { TRITONAI_PLUGIN_CATALOG_PATH: catalog },
      { TRITONAI_LOCAL_RELEASE_CANDIDATE: "true", TRITONAI_PLUGIN_CATALOG_PATH: catalog },
      { TRITONAI_LOCAL_RELEASE_CANDIDATE: "1", TRITONAI_PLUGIN_CATALOG_PATH: "relative.json" }
    ]) assert.throws(() => markLocalReleaseCandidate(env, tempRoot), /requires/);
    const env = { TRITONAI_LOCAL_RELEASE_CANDIDATE: "1", TRITONAI_PLUGIN_CATALOG_PATH: catalog };
    const marker = markLocalReleaseCandidate(env, tempRoot);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(marker, "utf8")), {
      schemaVersion: 1, kind: "tritonai-local-release-candidate",
      pluginCatalog: { path: catalog, sha256: crypto.createHash("sha256").update(fs.readFileSync(catalog)).digest("hex") }
    });
    const link = path.join(tempRoot, "symlink.json"); fs.symlinkSync(catalog, link);
    assert.throws(() => markLocalReleaseCandidate({ ...env, TRITONAI_PLUGIN_CATALOG_PATH: link }, tempRoot), /regular file/);
  });
}

function assertFailedRollbackRetainsRequiredProofAndBackups(failAtMarker = true) {
  withTempRoot("tritonai-proof-quarantine-failure-", (tempRoot) => {
    const requirementPath = path.join(tempRoot, "requirement.json");
    const previousMarker = '{"version":1,"required":false}\n';
    fs.writeFileSync(requirementPath, previousMarker);
    const stages = ["mac", "win"].map((platform) => {
      const stagingDir = path.join(tempRoot, `stage-${platform}`);
      const vendorDir = path.join(tempRoot, `vendor-${platform}`);
      fs.mkdirSync(stagingDir); fs.mkdirSync(vendorDir);
      fs.writeFileSync(path.join(vendorDir, "previous"), platform);
      fs.writeFileSync(path.join(stagingDir, pluginCompositionFile), JSON.stringify(compositionFixture()));
      return { stagingDir, vendorDir };
    });
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (failAtMarker && target === requirementPath && path.basename(source) === "requirement.json") throw new Error("injected marker activation failure");
      if (!failAtMarker && source === stages[1].stagingDir) throw new Error("injected Windows activation failure");
      if (source === stages[0].vendorDir && path.basename(target) === "failed-vendor") throw new Error("injected quarantine failure");
      return rename(source, target);
    };
    try { assert.throws(() => activatePreparedVendors(stages, requirementPath), /quarantine failure.*recovery backups kept/); }
    finally { fs.renameSync = rename; }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(requirementPath, "utf8")), { version: 1, required: true },
      "a failed rollback must not restore optional-proof policy over a failed generation");
    const backups = fs.readdirSync(tempRoot).filter((name) => name.startsWith(".harness-vendor-backup-")).map((name) => path.join(tempRoot, name));
    for (const stage of stages) {
      assert(backups.some((backup) => fs.existsSync(path.join(backup, path.basename(stage.vendorDir), "previous"))),
        "quarantine failure must preserve the complete previous payload generation");
    }
    const previousRequirement = backups.map((backup) => path.join(backup, "requirement.json")).find((file) => fs.existsSync(file));
    assert.strictEqual(fs.readFileSync(previousRequirement, "utf8"), previousMarker);
  });
}

assertCanonicalProvenance();
assertSafeCompositionPaths();
assertCompositionContract();
assertPlatformSpecificProofContract();
assertPackagedResourceInspection();
assertPublishedProofConsumption();
assertAtomicProofActivation();
assertCandidatePublicationMarker();
assertFailedRollbackRetainsRequiredProofAndBackups();
assertFailedRollbackRetainsRequiredProofAndBackups(false);
console.log("Managed Harness composition proof consumer tests passed.");
