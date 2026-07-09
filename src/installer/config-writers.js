const fs = require("fs");
const path = require("path");
const { UCSD } = require("./constants");
const { getCodexProviderEnvironmentVariables } = require("./codex-environment");
const { listSkillDirs } = require("./skills");

function ensureBaseFolders(paths) {
  [
    paths.ucsdRoot,
    paths.binDir,
    paths.configDir,
    paths.cacheDir,
    paths.dataDir,
    paths.logsDir,
    paths.policiesDir,
    paths.stateDir,
    paths.runtimeDir,
    paths.nodeRoot,
    paths.nodeGlobalRoot,
    paths.nodeGlobalBinDir,
    paths.codexRoot,
    paths.codexInstallRoot,
    paths.codexBinDir,
    paths.codexHome,
    paths.skillsDir,
    ...getT3SettingsPaths(paths).map((settingsPath) => path.dirname(settingsPath))
  ].filter(Boolean).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

  writeIfChanged(paths.sharedAgentsFile, `# UCSD AI Tooling

Use UCSD-approved endpoints and avoid committing secrets.

Default routing:
- Base URL: ${UCSD.baseUrl}
- API key env: ${UCSD.apiKeyEnv}
- TritonAI Harness home: ${paths.t3Home}
- Codex home: ${paths.codexHome}
- Logs: ${paths.logsDir}
- Skills: ${paths.skillsDir}
- Tool runtime: ${paths.runtimeDir}

Guardrails:
- Do not read or print .env, credential, token, or key files unless explicitly required.
- Ask before destructive file operations, external sends, or package publishing.
- Prefer project-local .agents instructions for repo-specific workflows.
`);

  writeIfChanged(path.join(paths.policiesDir, "guardrails.md"), `# UCSD Guardrails

- Keep API keys out of source control and logs.
- Route model traffic through UCSD infrastructure.
- Keep local actions reviewable and reversible.
- Store generated logs under ${paths.logsDir}.
`);
}

function seedOnboardingWorkspace(paths) {
  fs.mkdirSync(paths.onboardingWorkspaceDir, { recursive: true });
  writeIfMissing(
    path.join(paths.onboardingWorkspaceDir, "README.md"),
    buildOnboardingReadme(paths),
    0o644
  );
  writeIfChanged(paths.onboardingWorkspaceMarker, `${new Date().toISOString()}\n`);
}

function buildOnboardingReadme(paths) {
  const skillNames = listSkillDirs(paths.skillsDir).map((skillDir) => path.basename(skillDir));
  const skillList = skillNames.length
    ? skillNames.map((name) => `- ${name}`).join("\n")
    : "- No bundled managed secure skills were installed. TritonAI Harness can still use public, community, and user-added skills.";

  return `# TritonAI Harness

This folder is a starter workspace for TritonAI Harness.

## Start here

Open TritonAI Harness and ask:

\`\`\`text
How does TritonAI Harness work, and how can it help me?
\`\`\`

You can also ask it to explain files, draft code, summarize logs, or walk through a task step by step.

## What it can access

TritonAI Harness works with files and folders you open or ask it to inspect. It can read and write local project files when you approve or request that work, and it can run local commands needed for coding tasks.

Model requests are routed through UCSD-managed TritonAI infrastructure. Access is configured by the installer outside this workspace and should not be committed to source control.

## Installed UCSD setup

- Codex home: ${paths.codexHome}
- TritonAI Harness settings: ${paths.t3Settings}
- UCSD agent files: ${paths.ucsdRoot}
- Logs: ${paths.logsDir}
- Skills: ${paths.skillsDir}

## Available skills

${skillList}

## Good first prompts

- What can you help me do in this folder?
- Explain this project and suggest the next step.
- Check this code for bugs and missing tests.
- Help me turn this idea into a small working prototype.
`;
}

function writeT3CodeSettings(paths) {
  for (const settingsPath of getT3SettingsPaths(paths)) {
    const existing = readJson(settingsPath);
    writeJson(settingsPath, buildT3CodeSettings(existing, paths));
  }

  clearT3ProviderStatusCaches(paths);
  writeT3CodeDefaultsPatcher(paths);
}

function buildT3CodeSettings(existing, paths) {
  const codexModel = UCSD.codexModel;
  const customModels = getCodexModelSlugs(paths);
  const codexBinaryPath = getCodexBinaryPath(paths);
  const codexHomePath = paths.codexHome;
  const existingProviders = existing.providers || {};
  const existingProviderInstances = existing.providerInstances || {};
  const existingCodexProvider = existingProviders.codex || {};
  const existingClaudeProvider = existingProviders.claudeAgent || {};
  const existingCodexInstance = existingProviderInstances.codex || {};
  const existingClaudeInstance = existingProviderInstances.claudeAgent || {};
  const existingCodexConfig = existingCodexInstance.config || {};

  return {
    ...existing,
    providers: {
      ...disableProviderMap(existingProviders, "codex"),
      codex: {
        ...existingCodexProvider,
        enabled: true,
        binaryPath: codexBinaryPath,
        homePath: codexHomePath,
        customModels
      },
      claudeAgent: {
        ...existingClaudeProvider,
        enabled: false
      }
    },
    providerInstances: {
      ...disableProviderInstanceMap(existingProviderInstances, "codex"),
      codex: {
        ...existingCodexInstance,
        driver: "codex",
        enabled: true,
        config: {
          ...existingCodexConfig,
          enabled: true,
          binaryPath: codexBinaryPath,
          homePath: codexHomePath,
          customModels
        },
        environment: mergeEnvironmentVariables(
          existingCodexInstance.environment,
          getCodexProviderEnvironmentVariables(paths)
        )
      },
      claudeAgent: {
        ...existingClaudeInstance,
        driver: "claudeAgent",
        enabled: false,
        config: {
          ...(existingClaudeInstance.config || {}),
          enabled: false
        }
      }
    },
    textGenerationModelSelection: {
      instanceId: "codex",
      model: codexModel
    }
  };
}

function writeT3CodeDefaultsPatcher(paths) {
  const modelSelection = {
    instanceId: "codex",
    model: UCSD.codexModel
  };
  const customModels = getCodexModelSlugs(paths);
  const settingsPaths = getT3SettingsPaths(paths);
  const stateDbPaths = settingsPaths.map((settingsPath) => path.join(path.dirname(settingsPath), "state.sqlite"));
  const providerEnvironment = getCodexProviderEnvironmentVariables(paths)
    .filter((variable) => !variable.sensitive);
  const script = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const settingsPaths = ${JSON.stringify(settingsPaths)};
const stateDbPaths = ${JSON.stringify(stateDbPaths)};
const modelSelection = ${JSON.stringify(modelSelection)};
const customModels = ${JSON.stringify(customModels)};
const codexBinaryPath = ${JSON.stringify(getCodexBinaryPath(paths))};
const codexHomePath = ${JSON.stringify(paths.codexHome)};
const providerEnvironment = ${JSON.stringify(providerEnvironment)};
const providerStatusCacheDirs = ${JSON.stringify(getT3ProviderStatusCacheDirs(paths))};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\\n");
}

function mergeEnvironmentVariables(existing = [], additions = []) {
  const byName = new Map();
  for (const variable of Array.isArray(existing) ? existing : []) {
    if (variable && typeof variable.name === "string") {
      byName.set(variable.name, variable);
    }
  }
  for (const variable of additions) {
    byName.set(variable.name, variable);
  }
  return Array.from(byName.values());
}

function clearProviderStatusCaches() {
  for (const cacheDir of providerStatusCacheDirs) {
    try {
      for (const entry of fs.readdirSync(cacheDir)) {
        if (entry.endsWith(".json")) {
          fs.rmSync(path.join(cacheDir, entry), { force: true });
        }
      }
    } catch {
    }
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function disableProviderMap(providers = {}, enabledProviderId) {
  const disabled = {};
  for (const [providerId, provider] of Object.entries(objectValue(providers))) {
    if (providerId === enabledProviderId) continue;
    disabled[providerId] = {
      ...objectValue(provider),
      enabled: false
    };
  }
  return disabled;
}

function disableProviderInstanceMap(instances = {}, enabledProviderId) {
  const disabled = {};
  for (const [providerId, instance] of Object.entries(objectValue(instances))) {
    if (providerId === enabledProviderId) continue;
    const instanceObject = objectValue(instance);
    disabled[providerId] = {
      ...instanceObject,
      enabled: false,
      config: {
        ...objectValue(instanceObject.config),
        enabled: false
      }
    };
  }
  return disabled;
}

function enforceSettings(settingsPath) {
  const existing = readJson(settingsPath);
  const providers = existing.providers || {};
  const instances = existing.providerInstances || {};
  const codexProvider = providers.codex || {};
  const codexInstance = instances.codex || {};

  writeJson(settingsPath, {
    ...existing,
    providers: {
      ...disableProviderMap(providers, "codex"),
      codex: {
        ...codexProvider,
        enabled: true,
        binaryPath: codexBinaryPath,
        homePath: codexHomePath,
        customModels
      },
      claudeAgent: { ...(providers.claudeAgent || {}), enabled: false },
    },
    providerInstances: {
      ...disableProviderInstanceMap(instances, "codex"),
      codex: {
        ...codexInstance,
        driver: "codex",
        enabled: true,
        config: {
          ...(codexInstance.config || {}),
          enabled: true,
          binaryPath: codexBinaryPath,
          homePath: codexHomePath,
          customModels
        },
        environment: mergeEnvironmentVariables(codexInstance.environment, providerEnvironment)
      },
      claudeAgent: {
        ...(instances.claudeAgent || {}),
        driver: "claudeAgent",
        enabled: false,
        config: { ...((instances.claudeAgent || {}).config || {}), enabled: false }
      }
    },
    textGenerationModelSelection: modelSelection
  });
}

function openDatabase(stateDbPath) {
  try {
    return new (require("node:sqlite").DatabaseSync)(stateDbPath);
  } catch {
    return null;
  }
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db, table, column) {
  return db.prepare("PRAGMA table_info(" + table + ")").all().some((row) => row.name === column);
}

function allowedModelPlaceholders() {
  return customModels.map(() => "?").join(", ");
}

function patchSelectionColumn(db, table, column) {
  if (!hasTable(db, table) || !hasColumn(db, table, column)) return;
  const deletedFilter = hasColumn(db, table, "deleted_at") ? "AND deleted_at IS NULL" : "";
  db.prepare(\`
    UPDATE \${table}
    SET \${column} = ?
    WHERE (
      \${column} IS NULL
      OR COALESCE(json_extract(\${column}, '$.instanceId'), json_extract(\${column}, '$.provider'), '') != 'codex'
      OR json_extract(\${column}, '$.model') NOT IN (\${allowedModelPlaceholders()})
    )
    \${deletedFilter}
  \`).run(JSON.stringify(modelSelection), ...customModels);
}

function patchEvents(db, selectionKey) {
  if (!hasTable(db, "orchestration_events") || !hasColumn(db, "orchestration_events", "payload_json")) return;
  db.prepare(\`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.\${selectionKey}', json(?))
    WHERE json_type(payload_json, '$.\${selectionKey}') IS NOT NULL
      AND (
        COALESCE(json_extract(payload_json, '$.\${selectionKey}.instanceId'), json_extract(payload_json, '$.\${selectionKey}.provider'), '') != 'codex'
        OR json_extract(payload_json, '$.\${selectionKey}.model') NOT IN (\${allowedModelPlaceholders()})
      )
  \`).run(JSON.stringify(modelSelection), ...customModels);
}

function patchSessionState(db) {
  if (hasTable(db, "projection_thread_sessions")) {
    const hasProviderInstanceId = hasColumn(db, "projection_thread_sessions", "provider_instance_id");
    const providerInstanceColumn = hasProviderInstanceId
      ? ", provider_instance_id = 'codex'"
      : "";
    const providerSessionColumn = hasColumn(db, "projection_thread_sessions", "provider_session_id")
      ? ", provider_session_id = NULL"
      : "";
    const providerThreadColumn = hasColumn(db, "projection_thread_sessions", "provider_thread_id")
      ? ", provider_thread_id = NULL"
      : "";
    const activeTurnColumn = hasColumn(db, "projection_thread_sessions", "active_turn_id")
      ? ", active_turn_id = NULL"
      : "";
    const lastErrorColumn = hasColumn(db, "projection_thread_sessions", "last_error")
      ? ", last_error = NULL"
      : "";
    db.prepare(\`
      UPDATE projection_thread_sessions
      SET provider_name = 'codex',
          status = 'stopped'
          \${providerInstanceColumn}
          \${providerSessionColumn}
          \${providerThreadColumn}
          \${activeTurnColumn}
          \${lastErrorColumn}
    \`).run();
  }

  if (hasTable(db, "provider_session_runtime")) {
    const hasProviderInstanceId = hasColumn(db, "provider_session_runtime", "provider_instance_id");
    const providerInstanceColumn = hasProviderInstanceId
      ? "provider_instance_id = 'codex',"
      : "";
    db.prepare(\`
      UPDATE provider_session_runtime
      SET provider_name = 'codex',
          adapter_key = 'codex',
          status = 'stopped',
          resume_cursor_json = NULL,
          \${providerInstanceColumn}
          runtime_payload_json = CASE
            WHEN json_valid(runtime_payload_json) THEN json_set(
              runtime_payload_json,
              '$.model', ?,
              '$.modelSelection', json(?),
              '$.activeTurnId', NULL,
              '$.lastError', NULL
            )
            ELSE json_object('model', ?, 'modelSelection', json(?), 'activeTurnId', NULL, 'lastError', NULL)
          END
    \`).run(
      modelSelection.model,
      JSON.stringify(modelSelection),
      modelSelection.model,
      JSON.stringify(modelSelection),
    );
  }
}

function patchStateDatabase(stateDbPath) {
  if (!fs.existsSync(stateDbPath)) return;
  const db = openDatabase(stateDbPath);
  if (!db) return;
  try {
    patchSelectionColumn(db, "projection_projects", "default_model_selection_json");
    patchSelectionColumn(db, "projection_threads", "model_selection_json");
    patchEvents(db, "defaultModelSelection");
    patchEvents(db, "modelSelection");
    patchSessionState(db);
  } finally {
    db.close();
  }
}

for (const settingsPath of settingsPaths) {
  enforceSettings(settingsPath);
}
clearProviderStatusCaches();
for (const stateDbPath of stateDbPaths) {
  patchStateDatabase(stateDbPath);
}
`;

  writeIfChanged(paths.t3DefaultsPatcher, script);
  fs.chmodSync(paths.t3DefaultsPatcher, 0o755);
}

function writeJson(file, value) {
  writeIfChanged(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function mergeEnvironmentVariables(existing = [], additions = []) {
  const byName = new Map();
  for (const variable of Array.isArray(existing) ? existing : []) {
    if (variable && typeof variable.name === "string") {
      byName.set(variable.name, variable);
    }
  }
  for (const variable of additions) {
    byName.set(variable.name, variable);
  }
  return Array.from(byName.values());
}

function getCodexBinaryPath(paths) {
  if (paths.codexBinaryPath) return paths.codexBinaryPath;
  return path.join(paths.codexBinDir, paths.platform === "win32" ? "codex.cmd" : "codex");
}

function getCodexModelSlugs(paths = {}) {
  return Object.keys(getCodexModels(paths));
}

function getCodexModels(paths = {}) {
  return UCSD.codexModels;
}

function getT3SettingsPaths(paths) {
  const candidates = [
    paths.t3Settings,
    path.join(paths.t3Home, "dev", "settings.json")
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

function getT3ProviderStatusCacheDirs(paths) {
  return [
    path.join(paths.t3Home, "caches")
  ];
}

function clearT3ProviderStatusCaches(paths) {
  for (const cacheDir of getT3ProviderStatusCacheDirs(paths)) {
    try {
      for (const entry of fs.readdirSync(cacheDir)) {
        if (entry.endsWith(".json")) {
          fs.rmSync(path.join(cacheDir, entry), { force: true });
        }
      }
    } catch {
    }
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function disableProviderMap(providers = {}, enabledProviderId) {
  const disabled = {};
  for (const [providerId, provider] of Object.entries(objectValue(providers))) {
    if (providerId === enabledProviderId) continue;
    disabled[providerId] = {
      ...objectValue(provider),
      enabled: false
    };
  }
  return disabled;
}

function disableProviderInstanceMap(instances = {}, enabledProviderId) {
  const disabled = {};
  for (const [providerId, instance] of Object.entries(objectValue(instances))) {
    if (providerId === enabledProviderId) continue;
    const instanceObject = objectValue(instance);
    disabled[providerId] = {
      ...instanceObject,
      enabled: false,
      config: {
        ...objectValue(instanceObject.config),
        enabled: false
      }
    };
  }
  return disabled;
}

function writeIfChanged(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) {
    return;
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function writeIfMissing(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, content, { mode });
}

module.exports = {
  ensureBaseFolders,
  seedOnboardingWorkspace,
  writeT3CodeSettings
};
