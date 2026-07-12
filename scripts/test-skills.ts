const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  createManagedSkillsManifest
} = require("../src/installer/skill-manifest");
const {
  MANAGED_SKILLS_MANIFEST_FILE,
  installBundledSkills
} = require("../src/installer/skills");
const {
  assertCanonicalLocalSecureSkillsSource,
  assertCanonicalSecureSkillsRepository,
  findSkillsSourceDir,
  getEffectiveCloneRepositoryUrl,
  getEffectiveRepositoryUrl,
  sanitizeRepositoryUrl,
  stageSkillsFromSource
} = require("./prepare-skills-vendor");

function main() {
  assertSecureRepositoryProvenance();
  assertRootSecureRepositoryStaging();
  assertVendorActivationFailureRestoresPreviousBundle();
  assertRepositoryUrlSanitization();
  assertPreservesUnownedAndMigratesLegacyManifest();
  assertPreservesUnrecognizedRootManifest();
  assertManagedUpdatesAndRemovals();
  assertRejectsUnownedCollisions();
  assertStageFailurePreservesPreviousInstall();
  assertTransactionFailureRestoresPreviousInstallAndCleansBackup();
  assertRejectsInvalidBundles();
  console.log("Managed secure skills tests passed.");
}

function assertSecureRepositoryProvenance() {
  for (const repository of [
    "https://github.com/dbalders/UCSD-Skills-Library-Secure.git",
    "ssh://git@github.com/dbalders/UCSD-Skills-Library-Secure.git",
    "git@github.com:dbalders/UCSD-Skills-Library-Secure.git"
  ]) {
    assert.strictEqual(
      assertCanonicalSecureSkillsRepository(repository),
      "dbalders/UCSD-Skills-Library-Secure"
    );
  }
  for (const repository of [
    "https://github.com/dbalders/UCSD-Skills-Library.git",
    "https://github.com.evil.example/dbalders/UCSD-Skills-Library-Secure.git",
    "https://gitlab.com/dbalders/UCSD-Skills-Library-Secure.git",
    "ssh://git@ssh.github.com/dbalders/UCSD-Skills-Library-Secure.git",
    "https://github.com/extra/dbalders/UCSD-Skills-Library-Secure.git",
    "https://github.com/dbalders/UCSD-Skills-Library-Secure/extra",
    "git@github.com:extra/dbalders/UCSD-Skills-Library-Secure.git",
    "file:///private/build/UCSD-Skills-Library-Secure.git",
    "/private/build/UCSD-Skills-Library-Secure.git"
  ]) {
    assert.throws(
      () => assertCanonicalSecureSkillsRepository(repository, "UCSD_SKILLS_SOURCE"),
      /is not accepted as secure skills provenance/
    );
  }

  const credentialed = "https://credential-user@github.com/dbalders/UCSD-Skills-Library-Secure.git?value=query-value";
  assert.throws(() => assertCanonicalSecureSkillsRepository(credentialed), (error) => {
    assert(!error.message.includes("credential-user"));
    assert(!error.message.includes("query-value"));
    return /secure skills provenance/.test(error.message);
  });

  withTempRoot("tritonai-secure-provenance-", (tempRoot) => {
    execFileSync("git", ["init", "-q"], { cwd: tempRoot });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/dbalders/UCSD-Skills-Library.git"], { cwd: tempRoot });
    assert.throws(
      () => assertCanonicalLocalSecureSkillsSource(tempRoot),
      /is not accepted as secure skills provenance/
    );
    execFileSync("git", ["remote", "set-url", "origin", "corp:dbalders/UCSD-Skills-Library-Secure.git"], { cwd: tempRoot });
    execFileSync("git", ["config", "url.https://github.com/.insteadOf", "corp:"], { cwd: tempRoot });
    assert.strictEqual(
      getEffectiveRepositoryUrl(tempRoot),
      "https://github.com/dbalders/UCSD-Skills-Library-Secure.git"
    );
    assert.doesNotThrow(() => assertCanonicalLocalSecureSkillsSource(tempRoot));

    execFileSync("git", ["config", "--unset-all", "url.https://github.com/.insteadOf"], { cwd: tempRoot });
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/dbalders/UCSD-Skills-Library-Secure.git"], { cwd: tempRoot });
    execFileSync("git", ["config", "url.https://github.example.invalid/.insteadOf", "https://github.com/"], { cwd: tempRoot });
    assert.strictEqual(
      getEffectiveRepositoryUrl(tempRoot),
      "https://github.example.invalid/dbalders/UCSD-Skills-Library-Secure.git"
    );
    assert.throws(
      () => assertCanonicalLocalSecureSkillsSource(tempRoot),
      /github\.example\.invalid/
    );

    assert.strictEqual(
      getEffectiveCloneRepositoryUrl("https://github.com/dbalders/UCSD-Skills-Library-Secure.git", tempRoot),
      "https://github.example.invalid/dbalders/UCSD-Skills-Library-Secure.git"
    );
    assert.throws(
      () => assertCanonicalSecureSkillsRepository(
        getEffectiveCloneRepositoryUrl("https://github.com/dbalders/UCSD-Skills-Library-Secure.git", tempRoot)
      ),
      /github\.example\.invalid/
    );
  });
}

function assertVendorActivationFailureRestoresPreviousBundle() {
  withTempRoot("tritonai-secure-vendor-swap-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "skills");
    writeSkill(path.join(sourceRoot, "secure-new"), "secure-new", "new-v1");
    writeVendor(vendorDir, { "secure-existing": "existing-v1" });
    const manifestBefore = fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8");
    const originalRenameSync = fs.renameSync;
    let activationFailed = false;

    fs.renameSync = (source, target) => {
      if (!activationFailed && target === vendorDir && path.basename(source).startsWith(".secure-skills-vendor-")) {
        activationFailed = true;
        throw new Error("simulated vendor activation failure");
      }
      return originalRenameSync(source, target);
    };
    try {
      assert.throws(
        () => stageSkillsFromSource({ sourceRoot, vendorDir }),
        /simulated vendor activation failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assertSkillVersion(vendorDir, "secure-existing", "existing-v1");
    assert(!fs.existsSync(path.join(vendorDir, "secure-new")));
    assert.strictEqual(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"), manifestBefore);
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(vendorDir)).filter((name) => name.startsWith(".secure-skills-vendor-backup-")),
      []
    );
  });
}

function assertRepositoryUrlSanitization() {
  assert.strictEqual(
    sanitizeRepositoryUrl("https://secret-token@github.com/dbalders/UCSD-Skills-Library-Secure.git?token=also-secret"),
    "https://github.com/dbalders/UCSD-Skills-Library-Secure.git"
  );
  assert.strictEqual(sanitizeRepositoryUrl("/private/build/secure-skills.git"), "local-repository");
  assert.strictEqual(
    sanitizeRepositoryUrl("secret-token@github.com:dbalders/UCSD-Skills-Library-Secure.git?token=also-secret"),
    "github.com:dbalders/UCSD-Skills-Library-Secure.git"
  );
}

function assertRootSecureRepositoryStaging() {
  withTempRoot("tritonai-secure-source-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "UCSD-Skills-Library-Secure");
    const vendorDir = path.join(tempRoot, "vendor", "skills");
    writeSkill(path.join(sourceRoot, "secure-review"), "secure-review", "v1");
    writeSkill(path.join(sourceRoot, "ucsd-dsmlp-deploy"), "ucsd-dsmlp-deploy", "v1");
    fs.mkdirSync(path.join(sourceRoot, "docs"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "scripts"), { recursive: true });

    assert.strictEqual(findSkillsSourceDir(sourceRoot), sourceRoot);
    const result = stageSkillsFromSource({
      sourceRoot,
      vendorDir,
      sourceInfo: {
        type: "local",
        path: "/private/path/that-must-not-be-packaged",
        commit: "abc123",
        dirty: false
      }
    });

    assert.deepStrictEqual(result.skills, ["secure-review", "ucsd-dsmlp-deploy"]);
    assertFile(path.join(vendorDir, "secure-review", "SKILL.md"));
    assert(!fs.existsSync(path.join(vendorDir, "docs")), "support folders must not be bundled as skills");
    const manifest = readJson(path.join(vendorDir, "manifest.json"));
    assert.deepStrictEqual(
      { version: manifest.version, kind: manifest.kind, skills: manifest.skills },
      createManagedSkillsManifest(result.skills)
    );
    assert.deepStrictEqual(manifest.source, {
      type: "local",
      commit: "abc123",
      dirty: false
    });
    assert(!JSON.stringify(manifest).includes("private/path"), "vendor manifest must not expose local checkout paths");

    const wrapperRoot = path.join(tempRoot, "wrapper");
    writeSkill(path.join(wrapperRoot, "fixtures", "secure-override"), "secure-override", "v1");
    assert.strictEqual(
      findSkillsSourceDir(wrapperRoot, "fixtures"),
      path.join(wrapperRoot, "fixtures")
    );

    const invalidRoot = path.join(tempRoot, "invalid-source");
    writeSkill(path.join(invalidRoot, "Bad_Name"), "Bad_Name", "v1");
    assert.throws(
      () => stageSkillsFromSource({ sourceRoot: invalidRoot, vendorDir: path.join(tempRoot, "invalid-vendor") }),
      /invalid skill folder name/
    );
  });
}

function assertPreservesUnownedAndMigratesLegacyManifest() {
  withInstallFixture((fixture) => {
    writeVendor(fixture.vendorDir, { "secure-review": "secure-v1" });
    writeSkill(path.join(fixture.skillsDir, "tritonai-feedback"), "tritonai-feedback", "public-v1");
    writeSkill(path.join(fixture.skillsDir, "my-local-skill"), "my-local-skill", "user-v1");
    fs.writeFileSync(path.join(fixture.skillsDir, "manifest.json"), JSON.stringify({
      source: {
        type: "git",
        repo: "https://github.com/dbalders/UCSD-Skills-Library.git",
        ref: "main",
        commit: "a".repeat(40)
      },
      skills: ["tritonai-feedback"]
    }));

    const result = installFixture(fixture);
    assert.strictEqual(result.installed, 1);
    assert.strictEqual(result.removed, 0);
    assertSkillVersion(fixture.skillsDir, "secure-review", "secure-v1");
    assertSkillVersion(fixture.skillsDir, "tritonai-feedback", "public-v1");
    assertSkillVersion(fixture.skillsDir, "my-local-skill", "user-v1");
    assert(!fs.existsSync(path.join(fixture.skillsDir, "manifest.json")), "legacy root manifest should be removed");
    assert.deepStrictEqual(
      readJson(path.join(fixture.skillsDir, MANAGED_SKILLS_MANIFEST_FILE)),
      createManagedSkillsManifest(["secure-review"])
    );
  });
}

function assertPreservesUnrecognizedRootManifest() {
  withInstallFixture((fixture) => {
    writeVendor(fixture.vendorDir, { "secure-review": "secure-v1" });
    const unrelatedManifest = {
      source: { type: "another-tool" },
      skills: ["my-local-skill"]
    };
    fs.writeFileSync(
      path.join(fixture.skillsDir, "manifest.json"),
      `${JSON.stringify(unrelatedManifest, null, 2)}\n`
    );

    installFixture(fixture);

    assert.deepStrictEqual(
      readJson(path.join(fixture.skillsDir, "manifest.json")),
      unrelatedManifest
    );
    assertSkillVersion(fixture.skillsDir, "secure-review", "secure-v1");
  });
}

function assertManagedUpdatesAndRemovals() {
  withInstallFixture((fixture) => {
    writeSkill(path.join(fixture.skillsDir, "community-helper"), "community-helper", "public-v1");
    writeVendor(fixture.vendorDir, {
      "secure-retired": "retired-v1",
      "secure-review": "secure-v1"
    });
    installFixture(fixture);

    writeVendor(fixture.vendorDir, {
      "secure-new": "new-v1",
      "secure-review": "secure-v2"
    });
    const result = installFixture(fixture);

    assert.strictEqual(result.installed, 2);
    assert.strictEqual(result.removed, 1);
    assertSkillVersion(fixture.skillsDir, "secure-review", "secure-v2");
    assertSkillVersion(fixture.skillsDir, "secure-new", "new-v1");
    assert(!fs.existsSync(path.join(fixture.skillsDir, "secure-retired")), "retired managed skill should be removed");
    assertSkillVersion(fixture.skillsDir, "community-helper", "public-v1");
    assert.deepStrictEqual(
      readJson(path.join(fixture.skillsDir, MANAGED_SKILLS_MANIFEST_FILE)),
      createManagedSkillsManifest(["secure-new", "secure-review"])
    );
  });
}

function assertRejectsUnownedCollisions() {
  withInstallFixture((fixture) => {
    writeVendor(fixture.vendorDir, { "secure-review": "managed-v1" });
    writeSkill(path.join(fixture.skillsDir, "secure-review"), "secure-review", "unowned-v1");

    assert.throws(
      () => installFixture(fixture),
      /existing unowned skill uses that name/
    );
    assertSkillVersion(fixture.skillsDir, "secure-review", "unowned-v1");
    assert(!fs.existsSync(path.join(fixture.skillsDir, MANAGED_SKILLS_MANIFEST_FILE)));
  });
}

function assertStageFailurePreservesPreviousInstall() {
  withInstallFixture((fixture) => {
    writeSkill(path.join(fixture.skillsDir, "public-helper"), "public-helper", "public-v1");
    writeVendor(fixture.vendorDir, {
      "secure-retired": "retired-v1",
      "secure-review": "secure-v1"
    });
    installFixture(fixture);
    const manifestBefore = fs.readFileSync(path.join(fixture.skillsDir, MANAGED_SKILLS_MANIFEST_FILE), "utf8");

    writeVendor(fixture.vendorDir, {
      "secure-new": "new-v1",
      "secure-review": "secure-v2"
    });
    let copyCount = 0;
    assert.throws(
      () => installFixture(fixture, {
        copySkill: (source, target) => {
          copyCount += 1;
          if (copyCount === 2) throw new Error("simulated staged copy failure");
          fs.cpSync(source, target, { recursive: true });
        }
      }),
      /simulated staged copy failure/
    );

    assertSkillVersion(fixture.skillsDir, "secure-review", "secure-v1");
    assertSkillVersion(fixture.skillsDir, "secure-retired", "retired-v1");
    assert(!fs.existsSync(path.join(fixture.skillsDir, "secure-new")));
    assertSkillVersion(fixture.skillsDir, "public-helper", "public-v1");
    assert.strictEqual(
      fs.readFileSync(path.join(fixture.skillsDir, MANAGED_SKILLS_MANIFEST_FILE), "utf8"),
      manifestBefore
    );
  });
}

function assertTransactionFailureRestoresPreviousInstallAndCleansBackup() {
  withInstallFixture((fixture) => {
    writeVendor(fixture.vendorDir, { "secure-review": "secure-v1" });
    installFixture(fixture);
    const manifestBefore = fs.readFileSync(path.join(fixture.skillsDir, MANAGED_SKILLS_MANIFEST_FILE), "utf8");

    writeVendor(fixture.vendorDir, { "secure-review": "secure-v2" });
    const originalRenameSync = fs.renameSync;
    let activationFailed = false;
    fs.renameSync = (source, target) => {
      if (
        !activationFailed
        && target === path.join(fixture.skillsDir, "secure-review")
        && source.includes(".tritonai-secure-skills-stage-")
      ) {
        activationFailed = true;
        throw new Error("simulated managed skill activation failure");
      }
      return originalRenameSync(source, target);
    };
    try {
      assert.throws(
        () => installFixture(fixture),
        /simulated managed skill activation failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assertSkillVersion(fixture.skillsDir, "secure-review", "secure-v1");
    assert.strictEqual(
      fs.readFileSync(path.join(fixture.skillsDir, MANAGED_SKILLS_MANIFEST_FILE), "utf8"),
      manifestBefore
    );
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(fixture.skillsDir))
        .filter((name) => name.startsWith(".tritonai-secure-skills-backup-")),
      []
    );
  });
}

function assertRejectsInvalidBundles() {
  withInstallFixture((fixture) => {
    fs.mkdirSync(path.join(fixture.vendorDir, "secure-review"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.vendorDir, "manifest.json"),
      `${JSON.stringify({
        ...createManagedSkillsManifest(["secure-review"]),
        source: { repo: "https://github.com/dbalders/UCSD-Skills-Library-Secure.git" }
      }, null, 2)}\n`
    );
    assert.throws(() => installFixture(fixture), /missing SKILL.md/);
    assert.deepStrictEqual(fs.readdirSync(fixture.skillsDir), []);

    writeVendor(fixture.vendorDir, { "secure-review": "secure-v1" });
    const malformed = readJson(path.join(fixture.vendorDir, "manifest.json"));
    malformed.kind = "public";
    fs.writeFileSync(path.join(fixture.vendorDir, "manifest.json"), JSON.stringify(malformed));
    assert.throws(() => installFixture(fixture), /unsupported kind/);
    assert.deepStrictEqual(fs.readdirSync(fixture.skillsDir), []);

    writeVendor(fixture.vendorDir, { "secure-review": "secure-v1" });
    const publicSource = readJson(path.join(fixture.vendorDir, "manifest.json"));
    publicSource.source.repo = "https://github.com/dbalders/UCSD-Skills-Library.git";
    fs.writeFileSync(path.join(fixture.vendorDir, "manifest.json"), JSON.stringify(publicSource));
    assert.throws(() => installFixture(fixture), /canonical source repository/);
    assert.deepStrictEqual(fs.readdirSync(fixture.skillsDir), []);

    for (const repository of [
      "https://github.com.evil.example/dbalders/UCSD-Skills-Library-Secure.git",
      "https://github.com/dbalders/UCSD-Skills-Library-Secure/extra",
      "file:///private/build/UCSD-Skills-Library-Secure.git"
    ]) {
      writeVendor(fixture.vendorDir, { "secure-review": "secure-v1" });
      const hostileSource = readJson(path.join(fixture.vendorDir, "manifest.json"));
      hostileSource.source.repo = repository;
      fs.writeFileSync(path.join(fixture.vendorDir, "manifest.json"), JSON.stringify(hostileSource));
      assert.throws(() => installFixture(fixture), /canonical source repository/);
      assert.deepStrictEqual(fs.readdirSync(fixture.skillsDir), []);
    }
  });

  withInstallFixture((fixture) => {
    writeVendor(fixture.vendorDir, { "secure-review": "secure-v1" });
    const sshSource = readJson(path.join(fixture.vendorDir, "manifest.json"));
    sshSource.source.repo = "git@github.com:dbalders/UCSD-Skills-Library-Secure.git";
    fs.writeFileSync(path.join(fixture.vendorDir, "manifest.json"), JSON.stringify(sshSource));
    assert.strictEqual(installFixture(fixture).installed, 1);
  });
}

function withInstallFixture(callback) {
  withTempRoot("tritonai-secure-install-", (tempRoot) => {
    const appRoot = path.join(tempRoot, "app");
    const fixture = {
      tempRoot,
      appRoot,
      vendorDir: path.join(appRoot, "vendor", "skills"),
      skillsDir: path.join(tempRoot, "home", ".tritonai-harness", "codex", "skills")
    };
    fs.mkdirSync(fixture.skillsDir, { recursive: true });
    callback(fixture);
  });
}

function installFixture(fixture, options = {}) {
  return installBundledSkills({
    paths: { skillsDir: fixture.skillsDir },
    resourcesPath: null,
    appRoot: fixture.appRoot,
    emit: () => {},
    ...options
  });
}

function writeVendor(vendorDir, skills) {
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  const names = Object.keys(skills).sort();
  for (const name of names) {
    writeSkill(path.join(vendorDir, name), name, skills[name]);
  }
  fs.writeFileSync(
    path.join(vendorDir, "manifest.json"),
    `${JSON.stringify({
      ...createManagedSkillsManifest(names),
      source: {
        type: "git",
        repo: "https://github.com/dbalders/UCSD-Skills-Library-Secure.git",
        ref: "main",
        commit: "a".repeat(40)
      }
    }, null, 2)}\n`
  );
}

function writeSkill(skillDir, name, version) {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test fixture only.\n---\n\n${version}\n`
  );
}

function assertSkillVersion(skillsDir, name, version) {
  const content = fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
  assert(content.includes(version), `${name} should include ${version}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertFile(file) {
  assert(fs.existsSync(file), `Expected file: ${file}`);
  assert(fs.statSync(file).isFile(), `Expected regular file: ${file}`);
}

function withTempRoot(prefix, callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    callback(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
