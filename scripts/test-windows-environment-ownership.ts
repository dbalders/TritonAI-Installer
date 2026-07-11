const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { UCSD } = require("../src/installer/constants");
const { getNodeRuntimePaths } = require("../src/installer/prerequisites");
const { getPaths } = require("../src/installer/paths");
const { saveEnvironment } = require("../src/installer/profile");
const { writeInstallerVersionMarker } = require("../src/installer/installer-version-marker");
const {
  parseLegacyWindowsEnvironment,
  planWindowsEnvironmentCleanup,
  planWindowsPathCleanup,
  prepareWindowsEnvironmentMigration
} = require("../src/installer/windows-environment-migration");

async function main() {
  assertFreshInstallDoesNotClaimEnvironment();
  assertCurrentVersionRerunDoesNotMigrate();
  assertCompletedLegacyVersionsAreRecognized();
  assertIncompleteLegacyStateIsPreserved();
  assertUntrustedPendingStateIsPreserved();
  await assertCandidatesComeOnlyFromRecordedState();
  assertDifferingValuesAndAmbiguousPathsArePreserved();
  await assertFailureIsRetryableAndMigrationIsIdempotent();
  console.log("Windows environment ownership tests passed.");
}

function assertFreshInstallDoesNotClaimEnvironment() {
  withFixture(({ paths }) => {
    fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
    fs.writeFileSync(paths.envFile, legacyEnvironment("fresh-key"));
    assert.strictEqual(prepareWindowsEnvironmentMigration({ paths }), null);
    assert.strictEqual(fs.existsSync(paths.windowsEnvironmentMigrationState), false);
  });
}

function assertCurrentVersionRerunDoesNotMigrate() {
  withFixture(({ paths }) => {
    writeInstallerVersionMarker({ paths, installerVersion: "0.2.5" });
    fs.writeFileSync(paths.envFile, legacyEnvironment("current-key"));
    assert.strictEqual(prepareWindowsEnvironmentMigration({ paths }), null);
    assert.strictEqual(fs.existsSync(paths.windowsEnvironmentMigrationState), false);
  });
}

function assertCompletedLegacyVersionsAreRecognized() {
  withFixture(({ paths }) => {
    writeInstallerVersionMarker({ paths, installerVersion: "0.2.1" });
    fs.writeFileSync(paths.envFile, legacyEnvironment("legacy-021-key"));
    const migration = prepareWindowsEnvironmentMigration({ paths, executeCleanupScript: async () => {} });
    assert(migration, "a completed 0.2.1 marker should prove legacy Installer ownership");
    assert.strictEqual(migration.sourceInstallerVersion, "0.2.1");
  });

  withFixture(({ paths }) => {
    writeSupportReport(paths, { version: "0.2.0", ok: true });
    fs.writeFileSync(paths.envFile, legacyEnvironment("legacy-020-key", { legacyDoubleQuotes: true }));
    const migration = prepareWindowsEnvironmentMigration({ paths, executeCleanupScript: async () => {} });
    assert(migration, "a successful 0.2.0 support report should prove legacy Installer completion");
    assert.strictEqual(migration.sourceInstallerVersion, "0.2.0");
    assert(migration.candidates.pathEntries.includes("C:\\Legacy\\bin"));
  });
}

function assertIncompleteLegacyStateIsPreserved() {
  withFixture(({ paths }) => {
    writeSupportReport(paths, { version: "0.2.0", ok: false });
    fs.writeFileSync(paths.envFile, legacyEnvironment("incomplete-key"));
    assert.strictEqual(prepareWindowsEnvironmentMigration({ paths }), null);
    assert.strictEqual(fs.existsSync(paths.windowsEnvironmentMigrationState), false);
  });
}

function assertUntrustedPendingStateIsPreserved() {
  withFixture(({ paths }) => {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.windowsEnvironmentMigrationState, JSON.stringify({
      schemaVersion: 1,
      status: "pending",
      sourceInstallerVersion: "0.2.1",
      candidates: {
        environmentVariables: [{ name: "UNRELATED_USER_VALUE", value: "keep-me" }],
        pathEntries: []
      }
    }));
    assert.strictEqual(prepareWindowsEnvironmentMigration({ paths }), null);
  });
}

async function assertCandidatesComeOnlyFromRecordedState() {
  await withAsyncFixture(async ({ paths }) => {
    const recordedKey = "recorded-legacy-key";
    const submittedKey = "newly-submitted-key";
    writeInstallerVersionMarker({ paths, installerVersion: "0.2.1" });
    fs.writeFileSync(paths.envFile, legacyEnvironment(recordedKey));
    const nodeRuntime = getNodeRuntimePaths(paths, "win32", "x64");
    let cleanupScript = "";

    const migration = await saveEnvironment({
      apiKey: submittedKey,
      paths,
      platform: "win32",
      nodeRuntime,
      emit: () => {},
      windowsEnvironmentMigrationRuntime: {
        executeCleanupScript: async (script) => { cleanupScript = script; },
        now: () => new Date("2026-07-11T12:00:00.000Z")
      }
    });

    const pending = JSON.parse(fs.readFileSync(paths.windowsEnvironmentMigrationState, "utf8"));
    assert.strictEqual(pending.status, "pending");
    assert(JSON.stringify(pending.candidates).includes(recordedKey));
    assert(!JSON.stringify(pending.candidates).includes(submittedKey));
    assert(!JSON.stringify(pending.candidates).includes(paths.codexBinDir), "current managed paths must not become deletion candidates");
    assert(fs.readFileSync(paths.envFile, "utf8").includes(submittedKey), "the private launcher environment should receive the submitted key");

    await migration.finalize();
    assert(cleanupScript.includes(recordedKey));
    assert(!cleanupScript.includes(submittedKey));
    const completed = JSON.parse(fs.readFileSync(paths.windowsEnvironmentMigrationState, "utf8"));
    assert.deepStrictEqual(Object.keys(completed).sort(), ["completedAt", "schemaVersion", "sourceInstallerVersion", "status"]);
    assert.strictEqual(completed.status, "completed");
  });
}

function assertDifferingValuesAndAmbiguousPathsArePreserved() {
  const candidates = parseLegacyWindowsEnvironment(legacyEnvironment("old-key"));
  const exactPath = candidates.pathEntries[0];
  const distinctPath = "C:\\User\\bin";

  const differingKey = planWindowsEnvironmentCleanup({
    environmentVariables: { [UCSD.apiKeyEnv]: "new-key" },
    pathValue: `${exactPath};${distinctPath}`,
    candidates
  });
  assert.strictEqual(differingKey.environmentVariables[UCSD.apiKeyEnv], "new-key");
  assert.strictEqual(differingKey.pathValue, distinctPath);

  const exactLegacy = planWindowsEnvironmentCleanup({
    environmentVariables: { [UCSD.apiKeyEnv]: "old-key" },
    pathValue: distinctPath,
    candidates
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(exactLegacy.environmentVariables, UCSD.apiKeyEnv), false);

  for (const ambiguous of [
    `${exactPath};${exactPath};${distinctPath}`,
    `${exactPath.toLowerCase()};${distinctPath}`,
    `${exactPath}\\;${distinctPath}`,
    `${exactPath};${exactPath.toLowerCase()};${distinctPath}`,
    ` ${exactPath};${distinctPath}`
  ]) {
    const planned = planWindowsPathCleanup(ambiguous, [exactPath]);
    assert.strictEqual(planned.pathValue, ambiguous, `ambiguous PATH formatting must be preserved: ${ambiguous}`);
    assert.deepStrictEqual(planned.removedPathEntries, []);
  }

  const formatting = `${distinctPath};;${exactPath};`;
  assert.strictEqual(
    planWindowsPathCleanup(formatting, [exactPath]).pathValue,
    `${distinctPath};;`,
    "unrelated empty segments and trailing formatting must be preserved"
  );
}

async function assertFailureIsRetryableAndMigrationIsIdempotent() {
  await withAsyncFixture(async ({ paths }) => {
    writeInstallerVersionMarker({ paths, installerVersion: "0.2.1" });
    fs.writeFileSync(paths.envFile, legacyEnvironment("retry-key"));
    const first = prepareWindowsEnvironmentMigration({
      paths,
      executeCleanupScript: async () => { throw new Error("simulated cleanup failure"); }
    });
    await assert.rejects(first.finalize(), /simulated cleanup failure/);
    assert.strictEqual(JSON.parse(fs.readFileSync(paths.windowsEnvironmentMigrationState, "utf8")).status, "pending");

    let cleanupRuns = 0;
    const retry = prepareWindowsEnvironmentMigration({
      paths,
      executeCleanupScript: async () => { cleanupRuns += 1; }
    });
    await retry.finalize();
    await retry.finalize();
    assert.strictEqual(cleanupRuns, 1, "a migration transaction must finalize at most once");
    assert.strictEqual(JSON.parse(fs.readFileSync(paths.windowsEnvironmentMigrationState, "utf8")).status, "completed");
    assert.strictEqual(prepareWindowsEnvironmentMigration({ paths }), null, "completed migration state must make later installs no-ops");
  });
}

function legacyEnvironment(apiKey, { legacyDoubleQuotes = false } = {}) {
  if (legacyDoubleQuotes) {
    return [
      '$env:PATH = "C:\\Legacy\\bin;C:\\Legacy\\node;$env:PATH"',
      '$env:UCSD_AI_BASE_URL = "https://legacy.example.invalid/v1"',
      '$env:TRITONAI_HOME = "C:\\Users\\Test\\.tritonai-harness"',
      '$env:T3CODE_HOME = "C:\\Users\\Test\\.tritonai-harness"',
      '$env:CODEX_HOME = "C:\\Users\\Test\\.tritonai-harness\\codex"',
      `$env:${UCSD.apiKeyEnv} = "${apiKey}"`,
      ""
    ].join("\n");
  }
  return [
    "$env:PATH = 'C:\\Legacy\\bin;C:\\Legacy\\node;' + $env:PATH",
    "$env:UCSD_AI_BASE_URL = 'https://legacy.example.invalid/v1'",
    "$env:TRITONAI_HOME = 'C:\\Users\\Test\\.tritonai-harness'",
    "$env:CODEX_HOME = 'C:\\Users\\Test\\.tritonai-harness\\codex'",
    `$env:${UCSD.apiKeyEnv} = '${apiKey.replaceAll("'", "''")}'`,
    ""
  ].join("\n");
}

function writeSupportReport(paths, { version, ok }) {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.logsDir, "support-report-20260710T120000Z.json"), JSON.stringify({
    reportVersion: 1,
    generatedAt: "2026-07-10T12:00:00.000Z",
    ok,
    installer: { version, platform: "win32", arch: "x64" },
    paths: { ucsdRoot: paths.ucsdRoot, envFile: paths.envFile }
  }));
}

function withFixture(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-windows-environment-"));
  try {
    return callback({ tempRoot, paths: getPaths(tempRoot, "win32") });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function withAsyncFixture(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-windows-environment-"));
  try {
    return await callback({ tempRoot, paths: getPaths(tempRoot, "win32") });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
