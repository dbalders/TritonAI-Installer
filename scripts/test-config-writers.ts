const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { UCSD } = require("../src/installer/constants");
const { getPaths } = require("../src/installer/paths");
const {
  __test: {
    commitManagedSettingsUpdates,
    prepareManagedSettingsUpdates
  },
  writeT3CodeSettings
} = require("../src/installer/config-writers");

function getManagedSettingsPaths(paths) {
  return [
    paths.t3Settings,
    path.join(paths.t3Home, "dev", "settings.json")
  ];
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runDefaultsPatcher(paths) {
  return spawnSync(process.execPath, [paths.t3DefaultsPatcher], {
    encoding: "utf8"
  });
}

function withGeneratedPatcher(run) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-config-writers-"));
  try {
    const paths = getPaths(tempRoot, process.platform);
    writeT3CodeSettings(paths);
    run(paths);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertSessionMigrationPreservesCurrentCodexRows() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return;
  }

  withGeneratedPatcher((paths) => {
    const stateDbPath = path.join(path.dirname(paths.t3Settings), "state.sqlite");
    const db = new DatabaseSync(stateDbPath);
    db.exec(`
      CREATE TABLE provider_session_runtime (
        thread_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        provider_instance_id TEXT,
        adapter_key TEXT NOT NULL,
        runtime_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resume_cursor_json TEXT,
        runtime_payload_json TEXT
      );
      CREATE TABLE projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_instance_id TEXT,
        runtime_mode TEXT NOT NULL,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    const insertRuntime = db.prepare(`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key,
        runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRuntime.run(
      "thread-legacy",
      "legacyProvider",
      "legacy-instance",
      "legacyAdapter",
      "full-access",
      "running",
      "2026-07-11T01:00:00.000Z",
      JSON.stringify({ cursor: "legacy" }),
      JSON.stringify({
        model: "retired-model",
        activeTurnId: "legacy-turn",
        lastError: "legacy failure",
        customRuntimeField: "preserved for conversion"
      })
    );
    insertRuntime.run(
      "thread-codex",
      "codex",
      "codex-work",
      "codex-runtime-adapter",
      "read-only",
      "running",
      "2026-07-11T02:00:00.000Z",
      JSON.stringify({ cursor: "resume-codex", sequence: 42 }),
      JSON.stringify({
        model: "gpt-5.5",
        modelSelection: { instanceId: "codex-work", model: "gpt-5.5" },
        activeTurnId: "active-codex-turn",
        lastError: "recoverable codex error",
        customRuntimeField: { keep: true }
      })
    );

    const insertProjection = db.prepare(`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, runtime_mode,
        provider_session_id, provider_thread_id, active_turn_id, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertProjection.run(
      "thread-legacy",
      "running",
      "legacyProvider",
      "legacy-instance",
      "full-access",
      "legacy-session",
      "legacy-thread",
      "legacy-turn",
      "legacy failure",
      "2026-07-11T01:00:00.000Z"
    );
    insertProjection.run(
      "thread-codex",
      "running",
      "codex",
      "codex-work",
      "read-only",
      "codex-session",
      "codex-thread",
      "active-codex-turn",
      "recoverable codex error",
      "2026-07-11T02:00:00.000Z"
    );
    insertProjection.run(
      "thread-unknown-provider",
      "running",
      null,
      "custom-instance-without-driver",
      "full-access",
      "unknown-session",
      "unknown-thread",
      "unknown-turn",
      "unknown provider must not be guessed",
      "2026-07-11T03:00:00.000Z"
    );

    const currentRuntimeBefore = db.prepare(
      "SELECT * FROM provider_session_runtime WHERE thread_id = 'thread-codex'"
    ).get();
    const currentProjectionBefore = db.prepare(
      "SELECT * FROM projection_thread_sessions WHERE thread_id = 'thread-codex'"
    ).get();
    const unknownProjectionBefore = db.prepare(
      "SELECT * FROM projection_thread_sessions WHERE thread_id = 'thread-unknown-provider'"
    ).get();
    db.close();

    const firstRun = runDefaultsPatcher(paths);
    assert.strictEqual(firstRun.status, 0, firstRun.stderr);

    const patched = new DatabaseSync(stateDbPath);
    const currentRuntimeAfter = patched.prepare(
      "SELECT * FROM provider_session_runtime WHERE thread_id = 'thread-codex'"
    ).get();
    const currentProjectionAfter = patched.prepare(
      "SELECT * FROM projection_thread_sessions WHERE thread_id = 'thread-codex'"
    ).get();
    const unknownProjectionAfter = patched.prepare(
      "SELECT * FROM projection_thread_sessions WHERE thread_id = 'thread-unknown-provider'"
    ).get();
    assert.deepStrictEqual(currentRuntimeAfter, currentRuntimeBefore);
    assert.deepStrictEqual(currentProjectionAfter, currentProjectionBefore);
    assert.deepStrictEqual(
      unknownProjectionAfter,
      unknownProjectionBefore,
      "rows without positive legacy provider identity must be preserved"
    );

    const legacyRuntime = patched.prepare(
      "SELECT * FROM provider_session_runtime WHERE thread_id = 'thread-legacy'"
    ).get();
    const legacyProjection = patched.prepare(
      "SELECT * FROM projection_thread_sessions WHERE thread_id = 'thread-legacy'"
    ).get();
    assert.strictEqual(legacyRuntime.provider_name, "codex");
    assert.strictEqual(legacyRuntime.provider_instance_id, "codex");
    assert.strictEqual(legacyRuntime.adapter_key, "codex");
    assert.strictEqual(legacyRuntime.status, "stopped");
    assert.strictEqual(legacyRuntime.resume_cursor_json, null);
    const legacyPayload = JSON.parse(legacyRuntime.runtime_payload_json);
    assert.strictEqual(legacyPayload.model, UCSD.codexModel);
    assert.strictEqual(legacyPayload.activeTurnId, null);
    assert.strictEqual(legacyPayload.lastError, null);
    assert.deepStrictEqual(legacyPayload.customRuntimeField, "preserved for conversion");
    assert.strictEqual(legacyProjection.provider_name, "codex");
    assert.strictEqual(legacyProjection.provider_instance_id, "codex");
    assert.strictEqual(legacyProjection.status, "stopped");
    assert.strictEqual(legacyProjection.provider_session_id, null);
    assert.strictEqual(legacyProjection.provider_thread_id, null);
    assert.strictEqual(legacyProjection.active_turn_id, null);
    assert.strictEqual(legacyProjection.last_error, null);

    const firstRuntimeRows = patched.prepare(
      "SELECT * FROM provider_session_runtime ORDER BY thread_id"
    ).all();
    const firstProjectionRows = patched.prepare(
      "SELECT * FROM projection_thread_sessions ORDER BY thread_id"
    ).all();
    patched.close();

    const secondRun = runDefaultsPatcher(paths);
    assert.strictEqual(secondRun.status, 0, secondRun.stderr);
    const repeated = new DatabaseSync(stateDbPath);
    assert.deepStrictEqual(
      repeated.prepare("SELECT * FROM provider_session_runtime ORDER BY thread_id").all(),
      firstRuntimeRows,
      "a repeated patcher run must not mutate already-converted or current Codex runtime rows"
    );
    assert.deepStrictEqual(
      repeated.prepare("SELECT * FROM projection_thread_sessions ORDER BY thread_id").all(),
      firstProjectionRows,
      "a repeated patcher run must not mutate already-converted or current Codex projection rows"
    );
    repeated.close();
  });
}

function assertValidUnknownSettingsSurvive() {
  withGeneratedPatcher((paths) => {
    const settingsPaths = getManagedSettingsPaths(paths);
    for (const [index, settingsPath] of settingsPaths.entries()) {
      writeText(settingsPath, `${JSON.stringify({
        userDefinedRoot: { path: index, keep: true },
        providers: {
          codex: { userDefinedProviderSetting: `provider-${index}` }
        },
        providerInstances: {
          codex: {
            userDefinedInstanceSetting: `instance-${index}`,
            config: { userDefinedConfigSetting: `config-${index}` },
            environment: [{ name: `USER_DEFINED_${index}`, value: "keep" }]
          }
        }
      }, null, 2)}\n`);
    }

    const result = runDefaultsPatcher(paths);
    assert.strictEqual(result.status, 0, result.stderr);
    for (const [index, settingsPath] of settingsPaths.entries()) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.deepStrictEqual(settings.userDefinedRoot, { path: index, keep: true });
      assert.strictEqual(settings.providers.codex.userDefinedProviderSetting, `provider-${index}`);
      assert.strictEqual(
        settings.providerInstances.codex.userDefinedInstanceSetting,
        `instance-${index}`
      );
      assert.strictEqual(
        settings.providerInstances.codex.config.userDefinedConfigSetting,
        `config-${index}`
      );
      assert(
        settings.providerInstances.codex.environment.some(
          (entry) => entry.name === `USER_DEFINED_${index}` && entry.value === "keep"
        )
      );
    }
  });
}

function assertInvalidMultiPathSettingsFailClosed(label, invalidRaw) {
  withGeneratedPatcher((paths) => {
    const [firstPath, secondPath] = getManagedSettingsPaths(paths);
    const firstRaw = `${JSON.stringify({ userValue: `${label}-first` }, null, 2)}\n`;
    writeText(firstPath, firstRaw);
    writeText(secondPath, invalidRaw);

    const result = runDefaultsPatcher(paths);
    assert.notStrictEqual(result.status, 0, `${label} input should fail`);
    assert(
      result.stderr.includes(secondPath),
      `${label} diagnostic should identify ${secondPath}: ${result.stderr}`
    );
    assert.strictEqual(fs.readFileSync(firstPath, "utf8"), firstRaw);
    assert.strictEqual(fs.readFileSync(secondPath, "utf8"), invalidRaw);
  });
}

function assertUnreadableMultiPathSettingsFailClosed() {
  withGeneratedPatcher((paths) => {
    const [firstPath, secondPath] = getManagedSettingsPaths(paths);
    const firstRaw = `${JSON.stringify({ userValue: "unreadable-first" }, null, 2)}\n`;
    writeText(firstPath, firstRaw);
    fs.rmSync(secondPath, { force: true });
    fs.mkdirSync(secondPath, { recursive: true });

    const result = runDefaultsPatcher(paths);
    assert.notStrictEqual(result.status, 0, "an unreadable settings path should fail");
    assert(result.stderr.includes(secondPath), result.stderr);
    assert.strictEqual(fs.readFileSync(firstPath, "utf8"), firstRaw);
    assert(fs.statSync(secondPath).isDirectory());
  });
}

function assertConcurrentSettingsEditIsPreserved() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-concurrent-"));
  try {
    const firstPath = path.join(tempRoot, "one", "settings.json");
    const secondPath = path.join(tempRoot, "two", "settings.json");
    const firstRaw = "{\n  \"user\": \"first\"\n}\n";
    const secondRaw = "{\n  \"user\": \"second\"\n}\n";
    writeText(firstPath, firstRaw);
    writeText(secondPath, secondRaw);
    const updates = prepareManagedSettingsUpdates(
      [firstPath, secondPath],
      (existing) => ({ ...existing, managed: true })
    );

    const concurrentRaw = "{\n  \"user\": \"concurrent edit\"\n}\n";
    fs.writeFileSync(firstPath, concurrentRaw);
    assert.throws(
      () => commitManagedSettingsUpdates(updates),
      /concurrently changed/
    );
    assert.strictEqual(fs.readFileSync(firstPath, "utf8"), concurrentRaw);
    assert.strictEqual(fs.readFileSync(secondPath, "utf8"), secondRaw);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertAtomicFailureRollsBackAllManagedPaths() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-atomic-"));
  try {
    const firstPath = path.join(tempRoot, "one", "settings.json");
    const secondPath = path.join(tempRoot, "two", "settings.json");
    const firstRaw = "{\n  \"user\": \"first\"\n}\n";
    const secondRaw = "{\n  \"user\": \"second\"\n}\n";
    writeText(firstPath, firstRaw);
    writeText(secondPath, secondRaw);
    const updates = prepareManagedSettingsUpdates(
      [firstPath, secondPath],
      (existing) => ({ ...existing, managed: true })
    );

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === secondPath && String(source).includes(".replacement-")) {
        throw new Error("simulated atomic rename failure");
      }
      return originalRenameSync(source, destination);
    };
    try {
      assert.throws(
        () => commitManagedSettingsUpdates(updates),
        /simulated atomic rename failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(fs.readFileSync(firstPath, "utf8"), firstRaw);
    assert.strictEqual(fs.readFileSync(secondPath, "utf8"), secondRaw);
    assert.strictEqual(fs.readFileSync(`${firstPath}.tritonai-backup`, "utf8"), firstRaw);
    assert.strictEqual(fs.readFileSync(`${secondPath}.tritonai-backup`, "utf8"), secondRaw);
    for (const settingsPath of [firstPath, secondPath]) {
      const leftovers = fs.readdirSync(path.dirname(settingsPath)).filter(
        (name) => name.includes(".replacement-") || name.includes(".rollback-")
      );
      assert.deepStrictEqual(leftovers, [], `temporary files remain beside ${settingsPath}`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertRollbackPreservesConcurrentEdit() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-rollback-race-"));
  try {
    const firstPath = path.join(tempRoot, "one", "settings.json");
    const secondPath = path.join(tempRoot, "two", "settings.json");
    writeText(firstPath, "{\n  \"user\": \"first\"\n}\n");
    writeText(secondPath, "{\n  \"user\": \"second\"\n}\n");
    const updates = prepareManagedSettingsUpdates(
      [firstPath, secondPath],
      (existing) => ({ ...existing, managed: true })
    );
    const concurrentRaw = "{\n  \"user\": \"edit during rollback\"\n}\n";

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === secondPath && String(source).includes(".replacement-")) {
        fs.writeFileSync(firstPath, concurrentRaw);
        throw new Error("simulated second-path failure after concurrent edit");
      }
      return originalRenameSync(source, destination);
    };
    try {
      assert.throws(
        () => commitManagedSettingsUpdates(updates),
        /Rollback also failed.*concurrently changed/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.strictEqual(fs.readFileSync(firstPath, "utf8"), concurrentRaw);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  assertSessionMigrationPreservesCurrentCodexRows();
  assertValidUnknownSettingsSurvive();
  assertInvalidMultiPathSettingsFailClosed("malformed", "{not-json");
  assertInvalidMultiPathSettingsFailClosed("empty", "");
  assertInvalidMultiPathSettingsFailClosed("non-object", "[]\n");
  assertUnreadableMultiPathSettingsFailClosed();
  assertConcurrentSettingsEditIsPreserved();
  assertAtomicFailureRollsBackAllManagedPaths();
  assertRollbackPreservesConcurrentEdit();
  console.log("Config writer preservation tests passed.");
}

main();
