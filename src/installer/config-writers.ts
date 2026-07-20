const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
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
  const updates = prepareManagedSettingsUpdates(
    getT3SettingsPaths(paths),
    (existing) => buildT3CodeSettings(existing, paths),
    { platform: paths.platform, windowsAclRunner: paths.windowsAclRunner }
  );
  commitManagedSettingsUpdates(updates);

  clearT3ProviderStatusCaches(paths);
  writeT3CodeDefaultsPatcher(paths);
}

function buildT3CodeSettings(existing, paths) {
  const codexModel = getEffectiveCodexModel(paths);
  const customModels = getCodexModelSlugs(paths);
  const customModelMetadata = getCodexModelMetadata(paths);
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
        customModels,
        customModelMetadata
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
          customModels,
          customModelMetadata
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
    model: getEffectiveCodexModel(paths)
  };
  const customModels = getCodexModelSlugs(paths);
  const customModelMetadata = getCodexModelMetadata(paths);
  const settingsPaths = getT3SettingsPaths(paths);
  const stateDbPaths = settingsPaths.map((settingsPath) => path.join(path.dirname(settingsPath), "state.sqlite"));
  const providerEnvironment = getCodexProviderEnvironmentVariables(paths)
    .filter((variable) => !variable.sensitive);
  const script = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const settingsPaths = ${JSON.stringify(settingsPaths)};
const stateDbPaths = ${JSON.stringify(stateDbPaths)};
const managedSettingsPlatform = ${JSON.stringify(paths.platform)};
const modelSelection = ${JSON.stringify(modelSelection)};
const customModels = ${JSON.stringify(customModels)};
const customModelMetadata = ${JSON.stringify(customModelMetadata)};
const codexBinaryPath = ${JSON.stringify(getCodexBinaryPath(paths))};
const codexHomePath = ${JSON.stringify(paths.codexHome)};
const providerEnvironment = ${JSON.stringify(providerEnvironment)};
const providerStatusCacheDirs = ${JSON.stringify(getT3ProviderStatusCacheDirs(paths))};

${managedSettingsHelpersSource()}

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

function buildManagedSettings(existing) {
  const providers = existing.providers || {};
  const instances = existing.providerInstances || {};
  const codexProvider = providers.codex || {};
  const codexInstance = instances.codex || {};

  return {
    ...existing,
    providers: {
      ...disableProviderMap(providers, "codex"),
      codex: {
        ...codexProvider,
        enabled: true,
        binaryPath: codexBinaryPath,
        homePath: codexHomePath,
        customModels,
        customModelMetadata
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
          customModels,
          customModelMetadata
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
  };
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
    const legacyPredicate = legacyNonCodexPredicate(db, "projection_thread_sessions");
    if (legacyPredicate) {
      db.prepare(\`
        UPDATE projection_thread_sessions
        SET provider_name = 'codex',
            status = 'stopped'
            \${providerInstanceColumn}
            \${providerSessionColumn}
            \${providerThreadColumn}
            \${activeTurnColumn}
            \${lastErrorColumn}
        WHERE \${legacyPredicate}
      \`).run();
    }
  }

  if (hasTable(db, "provider_session_runtime")) {
    const hasProviderInstanceId = hasColumn(db, "provider_session_runtime", "provider_instance_id");
    const providerInstanceColumn = hasProviderInstanceId
      ? "provider_instance_id = 'codex',"
      : "";
    const legacyPredicate = legacyNonCodexPredicate(db, "provider_session_runtime");
    if (legacyPredicate) {
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
        WHERE \${legacyPredicate}
      \`).run(
        modelSelection.model,
        JSON.stringify(modelSelection),
        modelSelection.model,
        JSON.stringify(modelSelection),
      );
    }
  }
}

function legacyNonCodexPredicate(db, table) {
  if (!hasColumn(db, table, "provider_name")) return null;
  return "provider_name IS NOT NULL AND provider_name != 'codex'";
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

const settingsUpdates = prepareManagedSettingsUpdates(
  settingsPaths,
  buildManagedSettings,
  { platform: managedSettingsPlatform }
);
commitManagedSettingsUpdates(settingsUpdates);
clearProviderStatusCaches();
for (const stateDbPath of stateDbPaths) {
  patchStateDatabase(stateDbPath);
}
`;

  writeIfChanged(paths.t3DefaultsPatcher, script);
  fs.chmodSync(paths.t3DefaultsPatcher, 0o755);
}

let managedSettingsTempCounter = 0;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settingsError(action, file, error = undefined) {
  const detail = error && error.message ? `: ${error.message}` : "";
  return new Error(`Cannot ${action} managed TritonAI Harness settings at ${file}${detail}`, {
    cause: error
  });
}

function managedSettingsPowerShellScript(action) {
  const resolveFileAndIdentity = `
$ErrorActionPreference = "Stop"
$file = $env:TRITONAI_MANAGED_SETTINGS_FILE
if ([string]::IsNullOrWhiteSpace($file)) { throw "Managed settings path was not provided." }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw "Cannot resolve the installing user's Windows SID." }
`;
  const verifyOwner = `
$verifiedAcl = Get-Acl -LiteralPath $file
$verifiedOwner = $verifiedAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($verifiedOwner.Value -ne $sid.Value) {
  throw "Managed settings owner is not the installing user."
}
`;
  const verifyPrivateDacl = `
if (-not $verifiedAcl.AreAccessRulesProtected) {
  throw "Managed settings DACL still inherits access rules."
}
$verifiedRules = @($verifiedAcl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($verifiedRules.Count -ne 1) {
  throw "Managed settings DACL must contain exactly one access rule with no inherited access."
}
$verifiedRule = $verifiedRules[0]
if (
  $verifiedRule.IsInherited -or
  $verifiedRule.IdentityReference.Value -ne $sid.Value -or
  $verifiedRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  (($verifiedRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
    [System.Security.AccessControl.FileSystemRights]::FullControl)
) {
  throw "Managed settings DACL is not installing-user-only full control."
}
`;

  const privateAcl = `
$privateAcl = [System.Security.AccessControl.FileSecurity]::new()
$privateAcl.SetOwner($sid)
$privateAcl.SetAccessRuleProtection($true, $false)
$privateRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$privateAcl.AddAccessRule($privateRule)
`;

  if (action === "verify-owner") {
    return `${resolveFileAndIdentity}${verifyOwner}`;
  }
  if (action === "verify") {
    return `${resolveFileAndIdentity}${verifyOwner}${verifyPrivateDacl}`;
  }
  if (action === "create") {
    return `${resolveFileAndIdentity}${privateAcl}
$inputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $inputEncoding
$content = [Console]::In.ReadToEnd()
$encoding = [System.Text.UTF8Encoding]::new($false)
$bytes = $encoding.GetBytes($content)
$rights = ([System.Security.AccessControl.FileSystemRights]::Read -bor [System.Security.AccessControl.FileSystemRights]::Write)
$stream = [System.IO.FileStream]::new(
  $file,
  [System.IO.FileMode]::CreateNew,
  $rights,
  [System.IO.FileShare]::None,
  4096,
  [System.IO.FileOptions]::WriteThrough,
  $privateAcl
)
try {
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
} finally {
  $stream.Dispose()
}
${verifyOwner}${verifyPrivateDacl}`;
  }
  if (action !== "secure") {
    throw new Error(`Unsupported managed settings ACL action: ${action}`);
  }
  return `${resolveFileAndIdentity}${privateAcl}
Set-Acl -LiteralPath $file -AclObject $privateAcl
${verifyOwner}${verifyPrivateDacl}`;
}

function getWindowsPowerShellExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error("Cannot resolve the Windows system directory.");
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  if (!fs.existsSync(executable)) {
    throw new Error(`Cannot find the system Windows PowerShell executable at ${executable}.`);
  }
  return executable;
}

function runWindowsManagedSettingsAcl(file, action, content = undefined) {
  const encodedCommand = Buffer.from(managedSettingsPowerShellScript(action), "utf16le").toString("base64");
  const executable = getWindowsPowerShellExecutable();
  const systemModulePath = path.join(path.dirname(executable), "Modules");
  if (!fs.existsSync(systemModulePath)) {
    throw new Error(`Cannot find the system Windows PowerShell modules at ${systemModulePath}.`);
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => ![
      "psmodulepath",
      "tritonai_managed_settings_file"
    ].includes(name.toLowerCase()))
  );
  childEnvironment.PSModulePath = systemModulePath;
  childEnvironment.TRITONAI_MANAGED_SETTINGS_FILE = file;
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
    {
      encoding: "utf8",
      windowsHide: true,
      env: childEnvironment,
      input: action === "create" ? Buffer.from(content, "utf8") : undefined
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `PowerShell exited with ${result.status}`).trim();
    throw new Error(detail);
  }
}

function runManagedSettingsAccessAction(file, action, options = {}, content = undefined) {
  const runner = options["windowsAclRunner"] || runWindowsManagedSettingsAcl;
  return runner(file, action, content);
}

function runPosixManagedSettingsAcl(file, action, platform) {
  // Linux POSIX ACL named entries are bounded by the group-class mask. The
  // subsequent chmod(0600) sets that mask to zero, so stat mode verification
  // proves those entries have no effective access without optional ACL tools.
  if (platform === "linux") return;
  let command;
  let args;
  if (platform === "darwin") {
    if (action === "clear") {
      command = "/bin/chmod";
      args = ["-N", file];
    } else if (action === "verify") {
      command = "/bin/ls";
      args = ["-lde", file];
    }
  }
  if (!command || !args) {
    throw new Error(`Unsupported POSIX ACL ${action} operation on ${platform}.`);
  }

  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `${command} exited with ${result.status}`).trim();
    throw new Error(detail);
  }
  const output = String(result.stdout || "");
  if (action === "verify" && platform === "darwin") {
    const lines = output.split(/\r?\n/);
    const modeToken = String(lines[0] || "").trimStart().split(/\s+/, 1)[0];
    if (modeToken.endsWith("+") || lines.slice(1).some((line) => /^\s*\d+:/.test(line))) {
      throw new Error("managed settings still have extended ACL entries");
    }
  }
}

function runPosixManagedSettingsAccessAction(file, action, platform, options = {}) {
  const runner = options["posixAclRunner"] || runPosixManagedSettingsAcl;
  return runner(file, action, platform);
}

function assertSafeExistingManagedSettingsOwner(file, stat, options = {}) {
  const platform = options["platform"] || process.platform;
  try {
    if (platform === "win32") {
      runManagedSettingsAccessAction(file, "verify-owner", options);
      return;
    }
    const getUid = options["getUid"] || process.getuid;
    const installingUid = typeof getUid === "function" ? getUid() : undefined;
    if (!Number.isInteger(installingUid) || stat.uid !== installingUid) {
      throw new Error("owner is not the installing user");
    }
  } catch (error) {
    throw settingsError("verify safe ownership for", file, error);
  }
}

function verifyPrivateManagedSettingsAccess(file, options = {}) {
  const platform = options["platform"] || process.platform;
  try {
    if (platform === "win32") {
      runManagedSettingsAccessAction(file, "verify", options);
      return;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error("path is not a regular file");
    assertSafeExistingManagedSettingsOwner(file, stat, options);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`mode ${(stat.mode & 0o777).toString(8)} is not 600`);
    }
    runPosixManagedSettingsAccessAction(file, "verify", platform, options);
  } catch (error) {
    throw settingsError("verify user-only access for", file, error);
  }
}

function hasPrivateManagedSettingsAccess(file, stat, options = {}) {
  const platform = options["platform"] || process.platform;
  if (platform !== "win32") {
    if ((stat.mode & 0o777) !== 0o600) return false;
    try {
      runPosixManagedSettingsAccessAction(file, "verify", platform, options);
      return true;
    } catch {
      return false;
    }
  }
  try {
    runManagedSettingsAccessAction(file, "verify", options);
    return true;
  } catch {
    return false;
  }
}

function secureManagedSettingsFile(file, options = {}) {
  const platform = options["platform"] || process.platform;
  try {
    if (platform === "win32") {
      runManagedSettingsAccessAction(file, "secure", options);
    } else {
      runPosixManagedSettingsAccessAction(file, "clear", platform, options);
      fs.chmodSync(file, 0o600);
      verifyPrivateManagedSettingsAccess(file, options);
    }
  } catch (error) {
    throw settingsError("establish user-only access for", file, error);
  }
}

function readManagedSettingsSnapshot(file, options = {}) {
  if (!fs.existsSync(file)) {
    return { file, exists: false, raw: null, value: {}, accessIsPrivate: true, accessOptions: options };
  }

  let raw;
  let stat;
  try {
    stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error("path is not a regular file");
    assertSafeExistingManagedSettingsOwner(file, stat, options);
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw settingsError("read", file, error);
  }

  if (raw.trim() === "") {
    throw settingsError("parse empty", file);
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw settingsError("parse", file, error);
  }
  if (!isPlainObject(value)) {
    throw settingsError("use non-object JSON from", file);
  }
  return {
    file,
    exists: true,
    raw,
    value,
    device: stat.dev,
    inode: stat.ino,
    accessIsPrivate: hasPrivateManagedSettingsAccess(file, stat, options),
    accessOptions: options
  };
}

function prepareManagedSettingsUpdates(files, transform, options = {}) {
  const snapshots = files.map((file) => readManagedSettingsSnapshot(file, options));
  return snapshots.map((snapshot) => {
    const value = transform(snapshot.value, snapshot.file);
    if (!isPlainObject(value)) {
      throw settingsError("write non-object JSON to", snapshot.file);
    }
    return {
      ...snapshot,
      content: `${JSON.stringify(value, null, 2)}\n`
    };
  });
}

function managedSettingsTempPath(file, label) {
  managedSettingsTempCounter += 1;
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${label}-${process.pid}-${Date.now()}-${managedSettingsTempCounter}`
  );
}

function writeDurableTempFile(file, content, label, accessOptions = {}) {
  const tempPath = managedSettingsTempPath(file, label);
  let descriptor;
  try {
    if ((accessOptions["platform"] || process.platform) === "win32") {
      runManagedSettingsAccessAction(tempPath, "create", accessOptions, content);
      verifyPrivateManagedSettingsAccess(tempPath, accessOptions);
      return tempPath;
    }
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    secureManagedSettingsFile(tempPath, accessOptions);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    verifyPrivateManagedSettingsAccess(tempPath, accessOptions);
    return tempPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw settingsError("stage an atomic replacement for", file, error);
  }
}

function verifyManagedSettingsSnapshot(snapshot) {
  if (!snapshot.exists) {
    if (fs.existsSync(snapshot.file)) {
      throw settingsError("replace concurrently created", snapshot.file);
    }
    return;
  }

  let current;
  let currentStat;
  try {
    currentStat = fs.lstatSync(snapshot.file);
    if (!currentStat.isFile()) throw new Error("path is not a regular file");
    if (snapshot.accessIsPrivate) {
      verifyPrivateManagedSettingsAccess(snapshot.file, snapshot.accessOptions);
    } else {
      assertSafeExistingManagedSettingsOwner(snapshot.file, currentStat, snapshot.accessOptions);
    }
    current = fs.readFileSync(snapshot.file, "utf8");
  } catch (error) {
    throw settingsError("re-read before replacing", snapshot.file, error);
  }
  if (
    current !== snapshot.raw
    || currentStat.dev !== snapshot.device
    || currentStat.ino !== snapshot.inode
  ) {
    throw settingsError("replace concurrently changed", snapshot.file);
  }
}

function writeRecoveryBackup(update) {
  if (!update.exists || update.raw === update.content) return;
  const backupPath = `${update.file}.tritonai-backup`;
  const tempPath = writeDurableTempFile(backupPath, update.raw, "backup", update.accessOptions);
  let moved = false;
  try {
    fs.renameSync(tempPath, backupPath);
    moved = true;
    verifyPrivateManagedSettingsAccess(backupPath, update.accessOptions);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    if (moved) {
      try { fs.rmSync(backupPath, { force: true }); } catch {}
    }
    throw settingsError("preserve a recovery backup for", update.file, error);
  }
}

function rollbackManagedSettingsUpdate(update) {
  let current;
  try {
    current = fs.readFileSync(update.file, "utf8");
  } catch (error) {
    throw settingsError("verify before rolling back", update.file, error);
  }
  if (current !== update.content) {
    throw settingsError("roll back concurrently changed", update.file);
  }
  if (!update.exists) {
    fs.rmSync(update.file, { force: true });
    return;
  }
  const rollbackPath = writeDurableTempFile(update.file, update.raw, "rollback", update.accessOptions);
  try {
    fs.renameSync(rollbackPath, update.file);
    verifyPrivateManagedSettingsAccess(update.file, update.accessOptions);
  } catch (error) {
    try { fs.rmSync(rollbackPath, { force: true }); } catch {}
    throw error;
  }
}

function commitManagedSettingsUpdates(updates) {
  const changed = updates.filter(
    (update) => update.raw !== update.content || !update.accessIsPrivate
  );
  for (const update of updates) {
    verifyManagedSettingsSnapshot(update);
  }
  if (changed.length === 0) return;
  for (const update of changed) {
    fs.mkdirSync(path.dirname(update.file), { recursive: true });
  }

  const staged = [];
  const committed = [];
  try {
    for (const update of changed) {
      staged.push({
        update,
        tempPath: writeDurableTempFile(
          update.file,
          update.content,
          "replacement",
          update.accessOptions
        )
      });
    }
    for (const update of changed) {
      writeRecoveryBackup(update);
    }
    for (const entry of staged) {
      verifyManagedSettingsSnapshot(entry.update);
      if (entry.update.exists) {
        fs.renameSync(entry.tempPath, entry.update.file);
      } else {
        // Publish a newly created settings file without overwriting a file
        // another process created after the final absence check.
        fs.linkSync(entry.tempPath, entry.update.file);
      }
      committed.push(entry.update);
      if (!entry.update.exists) {
        fs.rmSync(entry.tempPath, { force: true });
      }
      entry.tempPath = null;
      verifyPrivateManagedSettingsAccess(entry.update.file, entry.update.accessOptions);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const update of committed.reverse()) {
      try {
        rollbackManagedSettingsUpdate(update);
      } catch (rollbackError) {
        rollbackErrors.push(`${update.file}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${error.message}. Rollback also failed for ${rollbackErrors.join("; ")}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    for (const entry of staged) {
      if (entry.tempPath) {
        try { fs.rmSync(entry.tempPath, { force: true }); } catch {}
      }
    }
  }
}

function managedSettingsHelpersSource() {
  return [
    "let managedSettingsTempCounter = 0;",
    isPlainObject.toString(),
    settingsError.toString(),
    managedSettingsPowerShellScript.toString(),
    getWindowsPowerShellExecutable.toString(),
    runWindowsManagedSettingsAcl.toString(),
    runManagedSettingsAccessAction.toString(),
    runPosixManagedSettingsAcl.toString(),
    runPosixManagedSettingsAccessAction.toString(),
    assertSafeExistingManagedSettingsOwner.toString(),
    verifyPrivateManagedSettingsAccess.toString(),
    hasPrivateManagedSettingsAccess.toString(),
    secureManagedSettingsFile.toString(),
    readManagedSettingsSnapshot.toString(),
    prepareManagedSettingsUpdates.toString(),
    managedSettingsTempPath.toString(),
    writeDurableTempFile.toString(),
    verifyManagedSettingsSnapshot.toString(),
    writeRecoveryBackup.toString(),
    rollbackManagedSettingsUpdate.toString(),
    commitManagedSettingsUpdates.toString()
  ].join("\n\n");
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

function getCodexModelSlugs(paths) {
  return Object.keys(getCodexModels(paths));
}

function getCodexModelMetadata(paths) {
  return Object.fromEntries(
    Object.entries(getCodexModels(paths)).map(([slug, model]) => {
      const descriptor = objectValue(model);
      return [
        slug,
        {
          name: typeof descriptor.name === "string" ? descriptor.name : slug,
          ...(typeof descriptor.shortName === "string"
            ? { shortName: descriptor.shortName }
            : {}),
          ...(descriptor.capabilities !== undefined
            ? { capabilities: descriptor.capabilities }
            : {})
        }
      ];
    })
  );
}

function getEffectiveCodexModel(paths) {
  return paths.externalModelsEnabled === true
    ? UCSD.codexModel
    : UCSD.restrictedCodexModel;
}

function getCodexModels(paths) {
  if (paths.externalModelsEnabled !== true) {
    // Key capability is an upper bound: a packaged operator catalog cannot
    // grant models that the installed key cannot access.
    return Object.fromEntries(
      Object.entries(UCSD.codexModels).filter(
        ([slug, model]) =>
          slug === UCSD.restrictedCodexModel ||
          objectValue(model).availableToRestrictedKeys === true
      )
    );
  }
  return UCSD.codexModels;
}

function getT3SettingsPaths(paths) {
  const candidates = [paths.t3Settings];
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
  writeT3CodeSettings,
  __test: {
    commitManagedSettingsUpdates,
    prepareManagedSettingsUpdates,
    secureManagedSettingsFile,
    verifyPrivateManagedSettingsAccess
  }
};
