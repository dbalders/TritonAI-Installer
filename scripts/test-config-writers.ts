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
    prepareManagedSettingsUpdates,
    secureManagedSettingsFile,
    verifyPrivateManagedSettingsAccess
  },
  writeT3CodeSettings
} = require("../src/installer/config-writers");

function getManagedSettingsPaths(paths) {
  return [paths.t3Settings];
}

function writeText(file, content) {
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (process.platform === "win32" && !existed) {
    secureManagedSettingsFile(file, { platform: "win32" });
  }
}

function makeWindowsSettingsPermissive(file) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  assert(systemRoot, "Windows system directory must be available");
  const icacls = path.join(systemRoot, "System32", "icacls.exe");
  const result = spawnSync(icacls, [file, "/grant", "*S-1-1-0:(R)"], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
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

function assertDevelopmentSettingsAreNotManaged() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-dev-settings-unmanaged-"));
  try {
    const paths = getPaths(tempRoot, process.platform);
    const devSettings = path.join(paths.t3Home, "dev", "settings.json");
    const devRaw = "{\n  \"developerOwned\": true,\n  \"credential\": \"leave-untouched\"\n}\n";
    writeText(devSettings, devRaw);
    const modeBefore = fs.statSync(devSettings).mode & 0o777;

    writeT3CodeSettings(paths);
    assert.strictEqual(fs.readFileSync(devSettings, "utf8"), devRaw);
    assert.strictEqual(fs.statSync(devSettings).mode & 0o777, modeBefore);

    const patcher = fs.readFileSync(paths.t3DefaultsPatcher, "utf8");
    assert(!patcher.includes(devSettings), "the production patcher must not manage development settings");
    const result = runDefaultsPatcher(paths);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(fs.readFileSync(devSettings, "utf8"), devRaw);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertInvalidMultiPathSettingsFailClosed(label, invalidRaw) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tritonai-settings-${label}-`));
  try {
    const firstPath = path.join(tempRoot, "one", "settings.json");
    const secondPath = path.join(tempRoot, "two", "settings.json");
    const firstRaw = `${JSON.stringify({ userValue: `${label}-first` }, null, 2)}\n`;
    writeText(firstPath, firstRaw);
    writeText(secondPath, invalidRaw);

    assert.throws(
      () => prepareManagedSettingsUpdates(
        [firstPath, secondPath],
        (existing) => ({ ...existing, managed: true })
      ),
      (error) => error.message.includes(secondPath),
      `${label} diagnostic should identify ${secondPath}`
    );
    assert.strictEqual(fs.readFileSync(firstPath, "utf8"), firstRaw);
    assert.strictEqual(fs.readFileSync(secondPath, "utf8"), invalidRaw);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertUnreadableMultiPathSettingsFailClosed() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-unreadable-"));
  try {
    const firstPath = path.join(tempRoot, "one", "settings.json");
    const secondPath = path.join(tempRoot, "two", "settings.json");
    const firstRaw = `${JSON.stringify({ userValue: "unreadable-first" }, null, 2)}\n`;
    writeText(firstPath, firstRaw);
    fs.mkdirSync(secondPath, { recursive: true });

    assert.throws(
      () => prepareManagedSettingsUpdates(
        [firstPath, secondPath],
        (existing) => ({ ...existing, managed: true })
      ),
      (error) => error.message.includes(secondPath),
      "an unreadable settings path should fail and identify the path"
    );
    assert.strictEqual(fs.readFileSync(firstPath, "utf8"), firstRaw);
    assert(fs.statSync(secondPath).isDirectory());
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

function assertPrivateSettingsFile(file) {
  verifyPrivateManagedSettingsAccess(file, { platform: process.platform });
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, `${file} must use mode 0600`);
    assert.strictEqual(fs.statSync(file).uid, process.getuid(), `${file} must be owned by the installing user`);
  }
}

function assertPermissiveSettingsAndBackupBecomePrivate() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-private-"));
  try {
    const paths = getPaths(tempRoot, process.platform);
    const original = "{\n  \"unknownSetting\": \"préservé 🌊\"\n}\n";
    writeText(paths.t3Settings, original);
    if (process.platform === "win32") {
      makeWindowsSettingsPermissive(paths.t3Settings);
    } else {
      fs.chmodSync(paths.t3Settings, 0o644);
    }

    writeT3CodeSettings(paths);

    const updated = JSON.parse(fs.readFileSync(paths.t3Settings, "utf8"));
    assert.strictEqual(updated.unknownSetting, "préservé 🌊");
    assertPrivateSettingsFile(paths.t3Settings);
    assert.strictEqual(fs.readFileSync(`${paths.t3Settings}.tritonai-backup`, "utf8"), original);
    assertPrivateSettingsFile(`${paths.t3Settings}.tritonai-backup`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertRestrictiveSettingsRemainPrivate() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-restrictive-"));
  try {
    const paths = getPaths(tempRoot, process.platform);
    writeText(paths.t3Settings, "{\n  \"restrictive\": true\n}\n");
    if (process.platform === "win32") {
      secureManagedSettingsFile(paths.t3Settings, { platform: "win32" });
    } else {
      fs.chmodSync(paths.t3Settings, 0o600);
    }

    writeT3CodeSettings(paths);
    assertPrivateSettingsFile(paths.t3Settings);
    assertPrivateSettingsFile(`${paths.t3Settings}.tritonai-backup`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertPermissionOnlyRepairDoesNotCreateBackup() {
  if (process.platform === "win32") return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-mode-only-"));
  try {
    const settingsPath = path.join(tempRoot, "settings.json");
    const raw = "{\n  \"alreadyManaged\": true\n}\n";
    writeText(settingsPath, raw);
    if (process.platform === "darwin") {
      fs.chmodSync(settingsPath, 0o600);
      const aclResult = spawnSync("/bin/chmod", ["+a", "everyone allow read", settingsPath], {
        encoding: "utf8"
      });
      assert.strictEqual(aclResult.status, 0, aclResult.stderr);
    } else {
      fs.chmodSync(settingsPath, 0o644);
    }
    const updates = prepareManagedSettingsUpdates(
      [settingsPath],
      (existing) => existing,
      { platform: process.platform }
    );

    commitManagedSettingsUpdates(updates);

    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), raw);
    assertPrivateSettingsFile(settingsPath);
    assert(!fs.existsSync(`${settingsPath}.tritonai-backup`));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertUnsafePosixOwnershipFailsClosed() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-owner-"));
  try {
    const settingsPath = path.join(tempRoot, "settings.json");
    const raw = "{\n  \"owner\": \"preserved\"\n}\n";
    writeText(settingsPath, raw);
    const actualUid = fs.statSync(settingsPath).uid;

    assert.throws(
      () => prepareManagedSettingsUpdates(
        [settingsPath],
        (existing) => ({ ...existing, managed: true }),
        { platform: "linux", getUid: () => actualUid + 1 }
      ),
      /owner is not the installing user/
    );
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), raw);
    assert(!fs.existsSync(`${settingsPath}.tritonai-backup`));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertPosixVerificationRejectsSymlinks() {
  if (process.platform === "win32") return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-symlink-"));
  try {
    const targetPath = path.join(tempRoot, "target.json");
    const settingsPath = path.join(tempRoot, "settings.json");
    writeText(targetPath, "{}\n");
    fs.chmodSync(targetPath, 0o600);
    fs.symlinkSync(targetPath, settingsPath);

    assert.throws(
      () => verifyPrivateManagedSettingsAccess(settingsPath, { platform: process.platform }),
      /path is not a regular file/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertWindowsOwnershipAndAclFailureBehavior() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-windows-acl-fail-"));
  try {
    const foreignOwnerPath = path.join(tempRoot, "foreign-owner", "settings.json");
    const permissivePath = path.join(tempRoot, "permissive", "settings.json");
    const aclPath = path.join(tempRoot, "acl", "settings.json");
    const raw = "{\n  \"windows\": \"preserved\"\n}\n";
    writeText(foreignOwnerPath, raw);
    writeText(permissivePath, raw);
    writeText(aclPath, raw);

    assert.throws(
      () => prepareManagedSettingsUpdates(
        [foreignOwnerPath],
        (existing) => ({ ...existing, managed: true }),
        {
          platform: "win32",
          windowsAclRunner: (_file, action) => {
            if (action === "verify-owner") throw new Error("simulated foreign Windows owner");
          }
        }
      ),
      /simulated foreign Windows owner/
    );
    assert.strictEqual(fs.readFileSync(foreignOwnerPath, "utf8"), raw);
    assert(!fs.existsSync(`${foreignOwnerPath}.tritonai-backup`));

    let repairedDacl = false;
    const permissiveUpdates = prepareManagedSettingsUpdates(
      [permissivePath],
      (existing) => ({ ...existing, managed: true }),
      {
        platform: "win32",
        windowsAclRunner: (file, action, content) => {
          if (action === "verify-owner") return;
          if (action === "verify" && !repairedDacl) {
            throw new Error("simulated inherited Windows DACL");
          }
          if (action === "create") {
            fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
            repairedDacl = true;
          }
        }
      }
    );
    commitManagedSettingsUpdates(permissiveUpdates);
    assert.strictEqual(JSON.parse(fs.readFileSync(permissivePath, "utf8")).managed, true);
    assert.strictEqual(fs.readFileSync(`${permissivePath}.tritonai-backup`, "utf8"), raw);

    const aclUpdates = prepareManagedSettingsUpdates(
      [aclPath],
      (existing) => ({ ...existing, managed: true }),
      {
        platform: "win32",
        windowsAclRunner: (_file, action) => {
          if (action === "verify-owner") return;
          if (action === "verify") throw new Error("simulated inherited Windows DACL");
          if (action === "create") throw new Error("simulated Windows DACL application failure");
        }
      }
    );
    assert.throws(
      () => commitManagedSettingsUpdates(aclUpdates),
      /simulated Windows DACL application failure/
    );
    assert.strictEqual(fs.readFileSync(aclPath, "utf8"), raw);
    assert(!fs.existsSync(`${aclPath}.tritonai-backup`));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertWindowsDaclCoversReplacementAndBackup() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-settings-windows-acl-"));
  try {
    const settingsPath = path.join(tempRoot, "settings.json");
    const raw = "{\n  \"windows\": \"original\"\n}\n";
    writeText(settingsPath, raw);
    const actions = [];
    const securedFiles = new Set();
    const options = {
      platform: "win32",
      windowsAclRunner: (file, action, content) => {
        actions.push({ file, action });
        if (action === "verify-owner") return;
        if (action === "create") {
          assert(!fs.existsSync(file), "the Windows ACL creator must use create-new semantics");
          fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
          securedFiles.add(file);
          return;
        }
        if (action === "verify" && securedFiles.size === 0 && file === settingsPath) {
          throw new Error("simulated inherited Windows DACL");
        }
      }
    };
    const updates = prepareManagedSettingsUpdates(
      [settingsPath],
      (existing) => ({ ...existing, managed: true }),
      options
    );

    commitManagedSettingsUpdates(updates);

    assert.strictEqual(fs.readFileSync(`${settingsPath}.tritonai-backup`, "utf8"), raw);
    assert(actions.some(({ file, action }) => action === "create" && file.includes(".replacement-")));
    assert(actions.some(({ file, action }) => action === "create" && file.includes(".backup-")));
    assert(actions.some(({ file, action }) => action === "verify" && file === settingsPath));
    assert(actions.some(({ file, action }) => action === "verify" && file === `${settingsPath}.tritonai-backup`));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  assertSessionMigrationPreservesCurrentCodexRows();
  assertValidUnknownSettingsSurvive();
  assertDevelopmentSettingsAreNotManaged();
  assertInvalidMultiPathSettingsFailClosed("malformed", "{not-json");
  assertInvalidMultiPathSettingsFailClosed("empty", "");
  assertInvalidMultiPathSettingsFailClosed("non-object", "[]\n");
  assertUnreadableMultiPathSettingsFailClosed();
  assertConcurrentSettingsEditIsPreserved();
  assertAtomicFailureRollsBackAllManagedPaths();
  assertRollbackPreservesConcurrentEdit();
  assertPermissiveSettingsAndBackupBecomePrivate();
  assertRestrictiveSettingsRemainPrivate();
  assertPermissionOnlyRepairDoesNotCreateBackup();
  assertUnsafePosixOwnershipFailsClosed();
  assertPosixVerificationRejectsSymlinks();
  assertWindowsOwnershipAndAclFailureBehavior();
  assertWindowsDaclCoversReplacementAndBackup();
  console.log("Config writer preservation tests passed.");
}

main();
