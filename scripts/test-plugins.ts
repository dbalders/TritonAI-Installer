const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertCanonicalPluginRepository,
  CANONICAL_PLUGIN_REPOSITORY_URL
} = require("../src/installer/plugin-provenance");
const {
  assertArtifactBinding,
  assertMatchingPluginComposition,
  isSafeRelativePath,
  validateManagedPluginBundleManifest
} = require("../src/installer/plugin-bundle-manifest");
const {
  findBundledPluginComposition,
  inspectBundledPluginComposition,
  readPluginCompositionRequirement
} = require("../src/installer/plugins");
const {
  assertCatalogComposition,
  readManagedPluginCatalog,
  validateManagedPluginCatalog
} = require("../src/installer/plugin-catalog");
const {
  compareStableVersions,
  parseArguments,
  parseLatestStablePluginRelease,
  parseSelectedPluginIds,
  readPluginSourceEnvironment,
  selectPluginSourceInput,
  stagePluginsFromSource,
  validatePluginManifest,
  validateSourceInput
} = require("./prepare-plugins-vendor");
const {
  pluginCompositionFile,
  publishedPluginCompositionFile,
  verifyPluginCompositionProof
} = require("./prepare-t3code-desktop-vendor");

const COMMIT = "a".repeat(40);
const managedPluginCatalogPath = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "managed-plugin-catalog.json"
);

function main() {
  assertCanonicalProvenance();
  assertReviewedPluginCatalog();
  assertLatestStableReleaseSelection();
  assertExplicitSourceContract();
  assertDeterministicSelectionAndStaging();
  assertCatalogValidationPrecedesActivation();
  assertProviderPackageStaging();
  assertRejectsUnsafePackages();
  assertAtomicVendorRollback();
  assertAtomicRequirementRollback();
  assertRollbackQuarantineFailurePreservesOneGeneration();
  assertCompositionContract();
  assertPlatformSpecificProofContract();
  assertSafeCompositionPaths();
  assertPackagedResourceInspection();
  console.log("Managed Harness plugin tests passed.");
}

function assertLatestStableReleaseSelection() {
  const catalog = readManagedPluginCatalog(managedPluginCatalogPath);
  assert.deepStrictEqual(parseArguments([]), { latest: false, production: false });
  assert.deepStrictEqual(parseArguments(["--latest"]), { latest: true, production: false });
  assert.deepStrictEqual(parseArguments(["--production"]), { latest: false, production: true });
  assert.throws(() => parseArguments(["--latest", "--latest"]), /only once/);
  assert.throws(() => parseArguments(["--production", "--production"]), /only once/);
  assert.throws(() => parseArguments(["--latest", "--production"]), /one release selection mode/);
  assert.throws(() => parseArguments(["--main"]), /Unsupported/);
  assert(compareStableVersions("0.10.0", "0.9.99") > 0);
  assert(compareStableVersions("10.0.0", "2.99.99") > 0);
  assert.strictEqual(compareStableVersions("1.2.3", "1.2.3"), 0);

  const latest = parseLatestStablePluginRelease([
    `${"1".repeat(40)}\trefs/tags/v0.1.0`,
    `${"2".repeat(40)}\trefs/tags/v0.10.0`,
    `${"3".repeat(40)}\trefs/tags/v1.0.0-rc.1`,
    `${"4".repeat(40)}\trefs/tags/plugins-v99`,
    `${"5".repeat(40)}\trefs/heads/v99.0.0`
  ].join("\n"));
  assert.deepStrictEqual(latest, {
    ref: "refs/tags/v0.10.0",
    commit: "2".repeat(40)
  });

  const annotated = parseLatestStablePluginRelease([
    `${"a".repeat(40)}\trefs/tags/v2.0.0`,
    `${"b".repeat(40)}\trefs/tags/v2.0.0^{}`
  ].join("\n"));
  assert.deepStrictEqual(annotated, {
    ref: "refs/tags/v2.0.0",
    commit: "b".repeat(40)
  });
  assert.throws(() => parseLatestStablePluginRelease(""), /no stable/);
  assert.throws(
    () => parseLatestStablePluginRelease([
      `${"a".repeat(40)}\trefs/tags/v1.0.0`,
      `${"b".repeat(40)}\trefs/tags/v1.0.0`
    ].join("\n")),
    /ambiguously/
  );

  const emptyInput = readPluginSourceEnvironment({});
  let resolverCalls = 0;
  const automatic = selectPluginSourceInput(emptyInput, { latest: true }, (repository) => {
    resolverCalls += 1;
    assert.strictEqual(repository, CANONICAL_PLUGIN_REPOSITORY_URL);
    return { repository, ref: "refs/tags/v1.2.3", commit: "c".repeat(40) };
  }, catalog);
  assert.strictEqual(resolverCalls, 1);
  assert.strictEqual(automatic.ref, "refs/tags/v1.2.3");
  assert.strictEqual(automatic.commit, "c".repeat(40));
  assert.deepStrictEqual(automatic.selectedIds, ["github", "google-workspace", "microsoft-365"]);

  const explicit = readPluginSourceEnvironment({
    TRITONAI_PLUGINS_REF: "refs/tags/v1.2.3",
    TRITONAI_PLUGINS_COMMIT: "d".repeat(40),
    TRITONAI_PLUGIN_IDS: "microsoft-365"
  });
  assert.strictEqual(
    selectPluginSourceInput(explicit, { latest: true }, () => { throw new Error("must not resolve latest"); }),
    explicit
  );
  assert.throws(
    () => selectPluginSourceInput({ ...explicit, commit: "" }, { latest: true }),
    /--latest does not complete partial managed plugin pins/
  );

  const production = selectPluginSourceInput(
    emptyInput,
    { latest: false, production: true },
    undefined,
    catalog
  );
  assert.deepStrictEqual(production.selectedIds, ["github", "google-workspace", "microsoft-365"]);
  assert.throws(
    () => selectPluginSourceInput(explicit, { latest: false, production: true }),
    /source overrides must be unset/
  );
}

function assertReviewedPluginCatalog() {
  const catalog = readManagedPluginCatalog(managedPluginCatalogPath);
  assert.deepStrictEqual(
    catalog.packages.map((plugin) => plugin.pluginId),
    ["github", "google-workspace", "microsoft-365"]
  );
  assert.strictEqual(validateManagedPluginCatalog(catalog), catalog);

  const composition = {
    version: 1,
    kind: "tritonai-harness-plugin-composition",
    source: { ...catalog.source },
    packages: catalog.packages.map((plugin) => ({
      id: plugin.pluginId,
      name: `@tritonai/plugin-${plugin.pluginId}`,
      version: plugin.version,
      digest: plugin.digest,
      files: [{
        path: ".tritonai-plugin/plugin.json",
        sha256: plugin.manifestDigest,
        size: 1
      }]
    }))
  };
  assert.strictEqual(assertCatalogComposition(catalog, composition), composition);
  assert.throws(
    () => assertCatalogComposition(catalog, {
      ...composition,
      packages: composition.packages.map((plugin, index) => index === 0
        ? { ...plugin, digest: "f".repeat(64) }
        : plugin)
    }),
    /catalog digests/
  );
  assert.throws(
    () => validateManagedPluginCatalog({ ...catalog, unexpected: true }),
    /unsupported fields/
  );
  assert.throws(
    () => validateManagedPluginCatalog({
      ...catalog,
      packages: catalog.packages.map((plugin, index) => index === 0
        ? { ...plugin, required: true }
        : plugin)
    }),
    /unsupported fields/
  );
  assert.throws(
    () => validateManagedPluginCatalog({
      ...catalog,
      packages: catalog.packages.map((plugin, index) => index === 0
        ? { ...plugin, artifactDescriptorDigest: "a".repeat(64) }
        : plugin)
    }),
    /unsupported fields/
  );
  assert.throws(
    () => validateManagedPluginCatalog({
      ...catalog,
      packages: [...catalog.packages].reverse()
    }),
    /sorted stable ids/
  );
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

function assertExplicitSourceContract() {
  assert.deepStrictEqual(parseSelectedPluginIds("zeta-reader,alpha-reader"), ["alpha-reader", "zeta-reader"]);
  assert.throws(() => parseSelectedPluginIds("alpha-reader,alpha-reader"), /duplicate/);
  assert.throws(() => parseSelectedPluginIds("../escape"), /invalid plugin id/);
  const environment = readPluginSourceEnvironment({
    TRITONAI_PLUGINS_REF: "refs/tags/plugins-v1",
    TRITONAI_PLUGINS_COMMIT: COMMIT,
    TRITONAI_PLUGIN_IDS: "alpha-reader"
  });
  assert.strictEqual(environment.repository, CANONICAL_PLUGIN_REPOSITORY_URL);
  assert.strictEqual(environment.localSource, "", "nearby checkouts must never be inferred");
  assert.deepStrictEqual(environment.selectedIds, ["alpha-reader"]);
  assert.throws(
    () => validateSourceInput({ ...environment, ref: "" }),
    /TRITONAI_PLUGINS_REF/
  );
  assert.throws(
    () => validateSourceInput({ ...environment, ref: "plugins-v1" }),
    /TRITONAI_PLUGINS_REF/
  );
  assert.throws(
    () => validateSourceInput({ ...environment, commit: "main" }),
    /TRITONAI_PLUGINS_COMMIT/
  );
  assert.throws(
    () => validateSourceInput({ ...environment, selectedIds: [] }),
    /TRITONAI_PLUGIN_IDS/
  );
}

function assertDeterministicSelectionAndStaging() {
  withTempRoot("tritonai-plugin-stage-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "zeta-reader", "1.2.3");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    fs.mkdirSync(path.join(sourceRoot, "plugins", "alpha-reader", "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "plugins", "alpha-reader", "src", "provider.ts"), "not packaged\n");
    fs.mkdirSync(path.join(sourceRoot, "plugins", "alpha-reader", "tests"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "plugins", "alpha-reader", "tests", "provider.test.ts"), "not packaged\n");

    const first = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader", "zeta-reader"],
      source: sourceIdentity()
    });
    assert.deepStrictEqual(first.packages.map((plugin) => plugin.id), ["alpha-reader", "zeta-reader"]);
    assert(!fs.existsSync(path.join(vendorDir, "packages", "alpha-reader", "src")));
    assert(!fs.existsSync(path.join(vendorDir, "packages", "alpha-reader", "tests")));
    const persisted = JSON.parse(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"));
    assert.deepStrictEqual(persisted, first);
    assert.strictEqual(validateManagedPluginBundleManifest(persisted), persisted);

    const firstBytes = fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8");
    const second = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader", "zeta-reader"],
      source: sourceIdentity()
    });
    assert.deepStrictEqual(second, first);
    assert.strictEqual(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"), firstBytes);
  });
}

function assertCatalogValidationPrecedesActivation() {
  withTempRoot("tritonai-plugin-catalog-transaction-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const compositionRequirementPath = path.join(tempRoot, "build", "managed-plugin-composition.json");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity(),
      compositionRequirementPath
    });
    const previousManifest = fs.readFileSync(path.join(vendorDir, "manifest.json"));
    const previousSkill = fs.readFileSync(
      path.join(vendorDir, "packages", "alpha-reader", "skills", "alpha-reader", "SKILL.md")
    );
    const previousRequirement = fs.readFileSync(compositionRequirementPath);

    assert.throws(
      () => stagePluginsFromSource({
        sourceRoot,
        vendorDir,
        selectedIds: ["alpha-reader"],
        source: sourceIdentity(),
        compositionRequirementPath,
        assertComposition: () => {
          throw new Error("simulated catalog mismatch");
        }
      }),
      /simulated catalog mismatch/
    );
    assert.deepStrictEqual(
      fs.readFileSync(path.join(vendorDir, "manifest.json")),
      previousManifest,
      "catalog rejection must preserve the previous vendor manifest"
    );
    assert.deepStrictEqual(
      fs.readFileSync(
        path.join(vendorDir, "packages", "alpha-reader", "skills", "alpha-reader", "SKILL.md")
      ),
      previousSkill,
      "catalog rejection must preserve the previous vendor payloads"
    );
    assert.deepStrictEqual(
      fs.readFileSync(compositionRequirementPath),
      previousRequirement,
      "catalog rejection must preserve the previous composition requirement"
    );
  });
}

function assertProviderPackageStaging() {
  withTempRoot("tritonai-provider-plugin-stage-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeProviderPlugin(sourceRoot, "provider-reader", "1.0.0");

    const composition = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["provider-reader"],
      source: sourceIdentity()
    });
    assert.deepStrictEqual(
      composition.packages[0].files.map(({ path: relative }) => relative),
      [
        ".tritonai-plugin/plugin.json",
        "README.md",
        "SECURITY.md",
        "dist/index.d.ts",
        "dist/index.js",
        "package.json",
        "skills/provider-reader/SKILL.md"
      ]
    );
    const stagedPackage = JSON.parse(
      fs.readFileSync(path.join(vendorDir, "packages", "provider-reader", "package.json"), "utf8")
    );
    assert.deepStrictEqual(stagedPackage.exports["."], {
      types: "./dist/index.d.ts",
      default: "./dist/index.js"
    });

    fs.rmSync(
      path.join(sourceRoot, "plugins", "provider-reader", "dist", "index.d.ts")
    );
    assert.throws(
      () => stagePluginsFromSource({
        sourceRoot,
        vendorDir,
        selectedIds: ["provider-reader"],
        source: sourceIdentity()
      }),
      /composed package is missing dist\/index\.d\.ts/
    );
  });
}

function assertRejectsUnsafePackages() {
  withTempRoot("tritonai-plugin-reject-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const packageFile = path.join(sourceRoot, "plugins", "alpha-reader", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    packageJson.files.push("src");
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /allowlist includes source/
    );

    packageJson.files = packageJson.files.filter((entry) => entry !== "src");
    packageJson.files.push("assets");
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /unsupported entry assets/
    );

    packageJson.files = packageJson.files.filter((entry) => entry !== "assets");
    packageJson.version = "2.0.0";
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /package\/manifest version drift/
    );

    packageJson.version = "1.0.0";
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    const nestedModules = path.join(sourceRoot, "plugins", "alpha-reader", "skills", "alpha-reader", "node_modules");
    fs.mkdirSync(nestedModules, { recursive: true });
    fs.writeFileSync(path.join(nestedModules, "injected.js"), "injected\n");
    assert.throws(
      () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
      /cannot contain node_modules content/
    );
    fs.rmSync(nestedModules, { recursive: true, force: true });
    const link = path.join(sourceRoot, "plugins", "alpha-reader", "skills", "alpha-reader", "linked.md");
    try {
      fs.symlinkSync("SKILL.md", link);
      assert.throws(
        () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
        /symbolic links/
      );
    } catch (error) {
      if (!error || !["EPERM", "EACCES"].includes(error.code)) throw error;
    }

    const badManifest: Record<string, any> = pluginManifest("alpha-reader", "1.0.0");
    badManifest.unsupported = true;
    assert.throws(() => validatePluginManifest(badManifest, "alpha-reader"), /unsupported fields/);

    const legacyRange: Record<string, any> = pluginManifest("alpha-reader", "1.0.0");
    legacyRange.compatibility = { harness: { min: "0.2.0", maxExclusive: "0.3.0" } };
    assert.throws(() => validatePluginManifest(legacyRange, "alpha-reader"), /unsupported fields/);

    const previousContract: Record<string, any> = pluginManifest("alpha-reader", "1.0.0");
    previousContract.apiVersion = "tritonai.harness/v1";
    previousContract.manifestVersion = 1;
    assert.throws(() => validatePluginManifest(previousContract, "alpha-reader"), /unsupported Harness/);

    const legacyCapability: Record<string, any> = pluginManifest("alpha-reader", "1.0.0");
    legacyCapability.skills[0].capability = legacyCapability.skills[0].capabilities[0];
    delete legacyCapability.skills[0].capabilities;
    assert.throws(() => validatePluginManifest(legacyCapability, "alpha-reader"), /unsupported fields/);

    const missingAccess: Record<string, any> = pluginManifest("alpha-reader", "1.0.0");
    delete missingAccess.capabilities[0].access;
    assert.throws(() => validatePluginManifest(missingAccess, "alpha-reader"), /capabilities/);
  });
}

function assertAtomicVendorRollback() {
  withTempRoot("tritonai-plugin-rollback-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, "previous"), "owned previous vendor\n");
    const originalRename = fs.renameSync;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (!failed && target === vendorDir && path.basename(source).startsWith(".managed-plugins-vendor-")) {
        failed = true;
        throw new Error("simulated plugin vendor activation failure");
      }
      return originalRename(source, target);
    };
    try {
      assert.throws(
        () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
        /simulated plugin vendor activation failure/
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(fs.readFileSync(path.join(vendorDir, "previous"), "utf8"), "owned previous vendor\n");

    const originalRenameForInitialFailure = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source === vendorDir) throw new Error("simulated previous vendor move failure");
      return originalRenameForInitialFailure(source, target);
    };
    try {
      assert.throws(
        () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
        /simulated previous vendor move failure/
      );
    } finally {
      fs.renameSync = originalRenameForInitialFailure;
    }
    assert.strictEqual(
      fs.readFileSync(path.join(vendorDir, "previous"), "utf8"),
      "owned previous vendor\n",
      "a failed initial rename must preserve the previous vendor"
    );

    const originalRenameForRollbackFailure = fs.renameSync;
    let activationFailed = false;
    fs.renameSync = (source, target) => {
      if (!activationFailed && target === vendorDir && path.basename(source).startsWith(".managed-plugins-vendor-")) {
        activationFailed = true;
        throw new Error("simulated plugin vendor activation failure");
      }
      if (activationFailed && target === vendorDir && path.basename(source) === "previous-vendor") {
        throw new Error("simulated plugin vendor rollback failure");
      }
      return originalRenameForRollbackFailure(source, target);
    };
    try {
      assert.throws(
        () => stagePluginsFromSource({ sourceRoot, vendorDir, selectedIds: ["alpha-reader"], source: sourceIdentity() }),
        /rollback failed: simulated plugin vendor rollback failure; previous release state kept at .*\.managed-plugins-vendor-backup-/
      );
    } finally {
      fs.renameSync = originalRenameForRollbackFailure;
    }
    const preservedBackup = fs.readdirSync(path.dirname(vendorDir))
      .find((name) => name.startsWith(".managed-plugins-vendor-backup-"));
    assert(preservedBackup, "a rollback failure must preserve the previous plugin vendor for recovery");
    fs.renameSync(
      path.join(path.dirname(vendorDir), preservedBackup, "previous-vendor"),
      vendorDir
    );
  });
}

function assertAtomicRequirementRollback() {
  withTempRoot("tritonai-plugin-requirement-rollback-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const compositionRequirementPath = path.join(tempRoot, "build", "managed-plugin-composition.json");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity(),
      compositionRequirementPath
    });
    const previousManifest = fs.readFileSync(path.join(vendorDir, "manifest.json"));
    const previousRequirement = fs.readFileSync(compositionRequirementPath);

    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.1");
    const originalRename = fs.renameSync;
    const originalRemove = fs.rmSync;
    let previousRequirementMoved = false;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (source === compositionRequirementPath) previousRequirementMoved = true;
      if (previousRequirementMoved && !failed && target === compositionRequirementPath) {
        failed = true;
        throw new Error("simulated composition requirement activation failure");
      }
      return originalRename(source, target);
    };
    fs.rmSync = (target, options) => {
      if (target === vendorDir || target === compositionRequirementPath) {
        throw new Error("rollback must not destructively remove live release state");
      }
      return originalRemove(target, options);
    };
    try {
      assert.throws(
        () => stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["alpha-reader"],
          source: sourceIdentity(),
          compositionRequirementPath
        }),
        /simulated composition requirement activation failure/
      );
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRemove;
    }
    assert.deepStrictEqual(
      fs.readFileSync(path.join(vendorDir, "manifest.json")),
      previousManifest,
      "requirement activation failure must restore the previous plugin vendor"
    );
    assert.deepStrictEqual(
      fs.readFileSync(compositionRequirementPath),
      previousRequirement,
      "requirement activation failure must restore the previous requirement marker"
    );
  });
}

function assertRollbackQuarantineFailurePreservesOneGeneration() {
  withTempRoot("tritonai-plugin-quarantine-rollback-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const requirementPath = path.join(tempRoot, "build", "managed-plugin-composition.json");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity(),
      compositionRequirementPath: requirementPath
    });
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.1");

    const originalRename = fs.renameSync;
    let previousRequirementMoved = false;
    fs.renameSync = (source, target) => {
      if (source === requirementPath) previousRequirementMoved = true;
      if (previousRequirementMoved && target === requirementPath) {
        throw new Error("simulated requirement activation failure");
      }
      if (source === vendorDir && path.basename(target) === "failed-vendor") {
        throw new Error("simulated vendor quarantine failure");
      }
      return originalRename(source, target);
    };
    try {
      assert.throws(
        () => stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["alpha-reader"],
          source: sourceIdentity(),
          compositionRequirementPath: requirementPath
        }),
        /rollback failed: simulated vendor quarantine failure/
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.strictEqual(fs.existsSync(requirementPath), false, "failed rollback must stay fail closed");
    const backup = fs.readdirSync(path.dirname(vendorDir))
      .find((name) => name.startsWith(".managed-plugins-vendor-backup-"));
    assert(backup, "failed rollback must preserve its complete previous generation");
    const backupRoot = path.join(path.dirname(vendorDir), backup);
    assert(fs.existsSync(path.join(backupRoot, "previous-vendor", "manifest.json")));
    assert(fs.existsSync(path.join(backupRoot, "previous-requirement.json")));
  });
}

function assertCompositionContract() {
  withTempRoot("tritonai-plugin-composition-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const expected = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity()
    });
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
    legacyRange.packages[0].compatibility = { harness: { min: "0.3.0", maxExclusive: "0.4.0" } };
    assert.throws(() => validateManagedPluginBundleManifest(legacyRange), /unsupported fields/);
    const drifted = structuredClone(expected);
    drifted.packages[0].version = "1.0.1";
    assert.throws(() => assertMatchingPluginComposition(expected, drifted), /does not match the exact prepared/);
  });
}

function assertPlatformSpecificProofContract() {
  withTempRoot("tritonai-platform-proofs-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const releaseDir = path.join(tempRoot, "release");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const expected = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity()
    });
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
          expectedManifestPath: path.join(vendorDir, "manifest.json"),
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
          expectedManifestPath: path.join(vendorDir, "manifest.json"),
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
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const resourcesPath = path.join(tempRoot, "resources");
    assert.throws(
      () => readPluginCompositionRequirement({ resourcesPath, appRoot: tempRoot, required: true }),
      /missing managed-plugin-composition.json/
    );
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, "managed-plugin-composition.json"), JSON.stringify({ version: 1, required: true }));
    assert.strictEqual(readPluginCompositionRequirement({ resourcesPath, appRoot: tempRoot, required: true }), true);
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const manifest = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity()
    });
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

function writeSkillPlugin(sourceRoot, id, version) {
  const packageRoot = path.join(sourceRoot, "plugins", id);
  fs.mkdirSync(path.join(packageRoot, ".tritonai-plugin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "skills", id), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "README.md"), `# ${id}\n`);
  fs.writeFileSync(path.join(packageRoot, "SECURITY.md"), "# Security\n");
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: `@tritonai/plugin-${id}`,
    version,
    files: [".tritonai-plugin", "skills", "README.md", "SECURITY.md"]
  }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(packageRoot, ".tritonai-plugin", "plugin.json"),
    `${JSON.stringify(pluginManifest(id, version), null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(packageRoot, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Read ${id} data.\n---\n# ${id}\n`
  );
}

function writeProviderPlugin(sourceRoot, id, version) {
  writeSkillPlugin(sourceRoot, id, version);
  const packageRoot = path.join(sourceRoot, "plugins", id);
  const packageFile = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  packageJson.files.push("dist");
  packageJson.exports = {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js"
    }
  };
  fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

  const manifestFile = path.join(packageRoot, ".tritonai-plugin", "plugin.json");
  const manifest: Record<string, any> = pluginManifest(id, version);
  manifest.provider = `${id}.provider`;
  manifest.tools = [
    {
      name: `${id}.records.list`,
      displayName: "List records",
      description: "List bounded records.",
      capabilities: [`${id}.read`],
      effect: "read"
    }
  ];
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const distributionRoot = path.join(packageRoot, "dist");
  fs.mkdirSync(distributionRoot, { recursive: true });
  fs.writeFileSync(
    path.join(distributionRoot, "index.js"),
    "export const manifest = {}; export function createIntegrationProvider() { return {}; }\n"
  );
  fs.writeFileSync(
    path.join(distributionRoot, "index.d.ts"),
    "export declare const manifest: unknown; export declare function createIntegrationProvider(input: unknown): unknown;\n"
  );
}

function pluginManifest(id, version) {
  return {
    apiVersion: "tritonai.harness/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id,
    name: id,
    description: `Read ${id} data.`,
    version,
    capabilities: [{ id: `${id}.read`, displayName: "Read", description: "Read data.", access: "default" }],
    tools: [],
    skills: [{ name: id, description: `Read ${id} data.`, capabilities: [`${id}.read`] }]
  };
}

function sourceIdentity() {
  return { repository: CANONICAL_PLUGIN_REPOSITORY_URL, ref: "refs/tags/plugins-v1", commit: COMMIT };
}

function withTempRoot(prefix, callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { callback(tempRoot); }
  finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
}

main();
