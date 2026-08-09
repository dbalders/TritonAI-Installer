const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { UCSD } = require("./constants");
const { writeFileAtomic } = require("./atomic-file");
const { terminateProcessTree } = require("./process-termination");

const WINDOWS_ENVIRONMENT_MIGRATION_SCHEMA_VERSION = 1;
const LEGACY_INSTALLER_VERSIONS = new Set(["0.2.0", "0.2.1"]);
const LEGACY_ENVIRONMENT_NAMES = new Set([
  UCSD.apiKeyEnv,
  UCSD.baseUrlEnv,
  UCSD.tritonAiHomeEnv,
  UCSD.codexHomeEnv,
  "T3CODE_HOME"
]);
const WINDOWS_ENVIRONMENT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

function prepareWindowsEnvironmentMigration({
  paths,
  executeCleanupScript = runPowerShell,
  now = () => new Date()
}) {
  const existingState = readMigrationState(paths.windowsEnvironmentMigrationState);
  if (existingState) {
    return existingState.status === "pending"
      ? createMigrationTransaction({ paths, state: existingState, executeCleanupScript, now })
      : null;
  }
  if (fs.existsSync(paths.windowsEnvironmentMigrationState)) {
    return null;
  }

  const sourceInstallerVersion = findCompletedLegacyInstallerVersion(paths);
  if (!sourceInstallerVersion || !fs.existsSync(paths.envFile)) {
    return null;
  }

  const candidates = parseLegacyWindowsEnvironment(fs.readFileSync(paths.envFile, "utf8"));
  if (candidates.environmentVariables.length === 0 && candidates.pathEntries.length === 0) {
    return null;
  }

  const state = {
    schemaVersion: WINDOWS_ENVIRONMENT_MIGRATION_SCHEMA_VERSION,
    status: "pending",
    sourceInstallerVersion,
    capturedAt: now().toISOString(),
    candidates
  };
  writeJsonAtomically(paths.windowsEnvironmentMigrationState, state);
  return createMigrationTransaction({ paths, state, executeCleanupScript, now });
}

function createMigrationTransaction({ paths, state, executeCleanupScript, now }) {
  let finalized = false;
  return {
    sourceInstallerVersion: state.sourceInstallerVersion,
    candidates: state.candidates,
    async finalize() {
      if (finalized) return;
      const script = buildWindowsEnvironmentCleanupScript(state.candidates);
      await executeCleanupScript(script, "removing recorded legacy TritonAI user environment variables");
      writeJsonAtomically(paths.windowsEnvironmentMigrationState, {
        schemaVersion: WINDOWS_ENVIRONMENT_MIGRATION_SCHEMA_VERSION,
        status: "completed",
        sourceInstallerVersion: state.sourceInstallerVersion,
        completedAt: now().toISOString()
      });
      finalized = true;
    }
  };
}

function findCompletedLegacyInstallerVersion(paths) {
  if (fs.existsSync(paths.installerVersionMarker)) {
    const marker = readJson(paths.installerVersionMarker);
    return marker
      && marker.schemaVersion === 1
      && LEGACY_INSTALLER_VERSIONS.has(marker.version)
      && isIsoDate(marker.installedAt)
      ? marker.version
      : null;
  }

  if (!fs.existsSync(paths.logsDir)) return null;
  const reportNames = fs.readdirSync(paths.logsDir)
    .filter((name) => /^support-report-.*\.json$/i.test(name))
    .sort()
    .reverse();
  for (const reportName of reportNames) {
    const report = readJson(path.join(paths.logsDir, reportName));
    if (
      report
      && report.reportVersion === 1
      && report.ok === true
      && report.installer
      && report.installer.platform === "win32"
      && LEGACY_INSTALLER_VERSIONS.has(report.installer.version)
      && report.paths
      && report.paths.ucsdRoot === paths.ucsdRoot
      && report.paths.envFile === paths.envFile
      && isIsoDate(report.generatedAt)
    ) {
      return report.installer.version;
    }
  }
  return null;
}

function parseLegacyWindowsEnvironment(content) {
  const environmentVariables = [];
  const pathEntries = [];

  for (const line of String(content || "").split(/\r?\n/)) {
    const pathValue = parseLegacyPathAssignment(line);
    if (pathValue !== null) {
      for (const entry of pathValue.split(";")) {
        if (entry && !pathEntries.includes(entry)) pathEntries.push(entry);
      }
      continue;
    }

    const match = line.match(/^\s*\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/i);
    if (!match) continue;
    const canonicalName = [...LEGACY_ENVIRONMENT_NAMES].find((name) => name.toLowerCase() === match[1].toLowerCase());
    const value = parsePowerShellLiteral(match[2]);
    if (!canonicalName || value === null || environmentVariables.some((item) => item.name === canonicalName)) continue;
    environmentVariables.push({ name: canonicalName, value });
  }

  return { environmentVariables, pathEntries };
}

function parseLegacyPathAssignment(line) {
  const literalPrefix = String(line || "").match(/^\s*\$env:PATH\s*=\s*(.+?)\s*\+\s*\$env:PATH\s*$/i);
  if (literalPrefix) {
    const parsed = parsePowerShellLiteral(literalPrefix[1]);
    return parsed === null ? null : parsed.replace(/;$/, "");
  }

  const interpolated = String(line || "").match(/^\s*\$env:PATH\s*=\s*"(.*);\$env:PATH"\s*$/i);
  return interpolated ? interpolated[1].replaceAll('\\"', '"') : null;
}

function parsePowerShellLiteral(value) {
  const trimmed = String(value || "").trim();
  const singleQuoted = trimmed.match(/^'((?:[^']|'')*)'$/);
  if (singleQuoted) return singleQuoted[1].replaceAll("''", "'");
  const doubleQuoted = trimmed.match(/^"(.*)"$/);
  if (doubleQuoted) return doubleQuoted[1].replaceAll('\\"', '"');
  return null;
}

function planWindowsEnvironmentCleanup({ environmentVariables = {}, pathValue = null, candidates }) {
  const updatedEnvironmentVariables = { ...environmentVariables };
  const removedEnvironmentVariables = [];
  for (const item of candidates.environmentVariables || []) {
    if (Object.prototype.hasOwnProperty.call(updatedEnvironmentVariables, item.name)
      && updatedEnvironmentVariables[item.name] === item.value) {
      delete updatedEnvironmentVariables[item.name];
      removedEnvironmentVariables.push(item.name);
    }
  }
  const pathPlan = planWindowsPathCleanup(pathValue, candidates.pathEntries || []);
  return {
    environmentVariables: updatedEnvironmentVariables,
    pathValue: pathPlan.pathValue,
    removedEnvironmentVariables,
    removedPathEntries: pathPlan.removedPathEntries
  };
}

function planWindowsPathCleanup(pathValue, candidates) {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return { pathValue, removedPathEntries: [] };
  }
  const parts = pathValue.split(";");
  const indexesToRemove = new Set();
  const removedPathEntries = [];

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const exactMatches = [];
    const semanticMatches = [];
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index] === candidate) exactMatches.push(index);
      if (windowsPathComparisonKey(parts[index]) === windowsPathComparisonKey(candidate)) semanticMatches.push(index);
    }
    if (exactMatches.length === 1 && semanticMatches.length === 1) {
      indexesToRemove.add(exactMatches[0]);
      removedPathEntries.push(candidate);
    }
  }

  return {
    pathValue: parts.filter((_, index) => !indexesToRemove.has(index)).join(";"),
    removedPathEntries
  };
}

function windowsPathComparisonKey(value) {
  return String(value || "").trim().replace(/[\\/]+$/, "").toLowerCase();
}

function buildWindowsEnvironmentCleanupScript({ environmentVariables = [], pathEntries = [] }) {
  const valueEntries = environmentVariables
    .map(({ name, value }) => `  [pscustomobject]@{ Name = ${powerShellLiteral(name)}; Value = ${powerShellLiteral(value)} }`)
    .join(",\n");
  const managedPaths = [...new Set(pathEntries.filter(Boolean))].map(powerShellLiteral).join(", ");

  return `
$changed = $false
$managedValues = @(
${valueEntries}
)
foreach ($item in $managedValues) {
  $current = [Environment]::GetEnvironmentVariable($item.Name, 'User')
  if ($null -ne $current -and $current -ceq $item.Value) {
    [Environment]::SetEnvironmentVariable($item.Name, $null, 'User')
    $changed = $true
  }
}

function Get-PathComparisonKey([string]$value) {
  if ($null -eq $value) { return '' }
  return $value.Trim().TrimEnd([char[]]'\\/').ToLowerInvariant()
}

$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($currentPath) {
  $parts = $currentPath.Split([char[]]';', [System.StringSplitOptions]::None)
  $managedPaths = @(${managedPaths})
  $removeIndexes = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($candidate in $managedPaths) {
    $exactMatches = @()
    $semanticMatches = @()
    for ($index = 0; $index -lt $parts.Count; $index += 1) {
      if ($parts[$index] -ceq $candidate) { $exactMatches += $index }
      if ((Get-PathComparisonKey $parts[$index]) -ceq (Get-PathComparisonKey $candidate)) { $semanticMatches += $index }
    }
    if ($exactMatches.Count -eq 1 -and $semanticMatches.Count -eq 1) {
      [void]$removeIndexes.Add($exactMatches[0])
    }
  }
  if ($removeIndexes.Count -gt 0) {
    $keptPaths = for ($index = 0; $index -lt $parts.Count; $index += 1) {
      if (-not $removeIndexes.Contains($index)) { $parts[$index] }
    }
    [Environment]::SetEnvironmentVariable('Path', ($keptPaths -join ';'), 'User')
    $changed = $true
  }
}

if ($changed) {
  $signature = @'
using System;
using System.Runtime.InteropServices;

public static class NativeMethods {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd,
    uint Msg,
    UIntPtr wParam,
    string lParam,
    uint fuFlags,
    uint uTimeout,
    out UIntPtr lpdwResult);
}
'@
  Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
  $result = [UIntPtr]::Zero
  [NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
}
`;
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readMigrationState(statePath) {
  const state = readJson(statePath);
  if (!state || state.schemaVersion !== WINDOWS_ENVIRONMENT_MIGRATION_SCHEMA_VERSION) return null;
  if (state.status === "completed") return state;
  if (
    state.status !== "pending"
    || !LEGACY_INSTALLER_VERSIONS.has(state.sourceInstallerVersion)
    || !state.candidates
    || !areValidCandidates(state.candidates)
  ) return null;
  return state;
}

function areValidCandidates(candidates) {
  return Array.isArray(candidates.environmentVariables)
    && candidates.environmentVariables.every((item) => item
      && LEGACY_ENVIRONMENT_NAMES.has(item.name)
      && typeof item.value === "string")
    && Array.isArray(candidates.pathEntries)
    && candidates.pathEntries.every((entry) => typeof entry === "string" && entry.length > 0);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomically(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function runPowerShell(command, description, {
  platform = process.platform,
  timeoutMs = WINDOWS_ENVIRONMENT_COMMAND_TIMEOUT_MS,
  spawnProcess = spawn,
  terminate = terminateProcessTree
} = {}) {
  return new Promise<void>((resolve, reject) => {
    if (platform !== "win32") {
      reject(new Error(`PowerShell cleanup is only available on Windows while ${description}`));
      return;
    }
    const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
    const child = spawnProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
      windowsHide: true
    });
    let settled = false;
    let timingOut = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      if (settled || timingOut) return;
      timingOut = true;
      void terminate(child, { platform: "win32" }).then(() => {
        settle(() => reject(Object.assign(
          new Error(`PowerShell timed out after ${timeoutMs}ms while ${description}; its process tree was terminated`),
          { code: "ETIMEDOUT" }
        )));
      }, (terminationError) => {
        settle(() => reject(Object.assign(new Error(
          `PowerShell timed out after ${timeoutMs}ms while ${description}, and termination could not be confirmed: ${terminationError.message}`,
          { cause: terminationError }
        ), { code: "ETERMINATE" })));
      });
    }, timeoutMs);
    child.on("error", (error) => {
      if (!timingOut) settle(() => reject(error));
    });
    child.on("close", (code) => {
      if (timingOut) return;
      if (code === 0) settle(resolve);
      else settle(() => reject(new Error(`PowerShell exited with code ${code} while ${description}`)));
    });
  });
}

module.exports = {
  buildWindowsEnvironmentCleanupScript,
  parseLegacyWindowsEnvironment,
  planWindowsEnvironmentCleanup,
  planWindowsPathCleanup,
  prepareWindowsEnvironmentMigration,
  runPowerShell
};
