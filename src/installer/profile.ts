const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { UCSD } = require("./constants");
const { getTritonAiEnvironment } = require("./codex-environment");
const { readApiKeyFromEnvFile } = require("./existing-api-key");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildWindowsEnvironmentLines({ apiKey, pathEntries, tritonAiEnvironment }) {
  return [
    `$env:PATH = ${powerShellLiteral(`${pathEntries.join(";")};`)} + $env:PATH`,
    ...Object.entries(tritonAiEnvironment).map(([name, value]) => `$env:${name} = ${powerShellLiteral(value)}`),
    apiKey ? `$env:${UCSD.apiKeyEnv} = ${powerShellLiteral(apiKey)}` : null
  ].filter(Boolean);
}

function buildMacEnvironmentLines({ apiKey, pathEntries, tritonAiEnvironment }) {
  return [
    `export PATH=${shellQuote(pathEntries.join(":"))}:$PATH`,
    ...Object.entries(tritonAiEnvironment).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    apiKey ? `export ${UCSD.apiKeyEnv}=${shellQuote(apiKey)}` : null
  ].filter(Boolean);
}

function buildWindowsEnvironmentCleanupScript({ apiKey, legacyApiKey, paths, pathEntries, tritonAiEnvironment }) {
  const managedApiKeys = [...new Set([apiKey, legacyApiKey].filter(Boolean))];
  const managedValues = [
    ...Object.entries(tritonAiEnvironment),
    [UCSD.codexHomeEnv, paths.codexHome],
    ...managedApiKeys.map((value) => [UCSD.apiKeyEnv, value])
  ];
  const valueEntries = managedValues
    .map(([name, value]) => `  [pscustomobject]@{ Name = ${powerShellLiteral(name)}; Value = ${powerShellLiteral(value)} }`)
    .join(",\n");
  const managedPaths = pathEntries.map((entry) => powerShellLiteral(entry)).join(", ");

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

$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($currentPath) {
  $managedPaths = @(${managedPaths})
  $keptPaths = @($currentPath -split ';' | Where-Object { $_ -and $managedPaths -notcontains $_ })
  $updatedPath = $keptPaths -join ';'
  if ($updatedPath -cne $currentPath) {
    [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
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

async function saveEnvironment({ apiKey, paths, platform, nodeRuntime, emit }) {
  fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
  const pathEntries = [paths.binDir, paths.codexBinDir, paths.nodeGlobalBinDir, nodeRuntime && nodeRuntime.nodeBinDir].filter(Boolean);
  const tritonAiEnvironment = getTritonAiEnvironment(paths) as Record<string, string>;

  if (platform === "win32") {
    if (process.platform === "win32") {
      const legacyApiKey = readApiKeyFromEnvFile(paths.envFile);
      const cleanupScript = buildWindowsEnvironmentCleanupScript({ apiKey, legacyApiKey, paths, pathEntries, tritonAiEnvironment });
      await runPowerShell(cleanupScript, "removing legacy TritonAI user environment variables");
    }
    const lines = buildWindowsEnvironmentLines({ apiKey, pathEntries, tritonAiEnvironment });

    fs.writeFileSync(paths.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
    emit(`Saved private TritonAI Harness environment at ${paths.envFile}`);
    return;
  }

  removeLegacyShellProfileIntegration(paths.homeDir, paths.envFile);
  const lines = buildMacEnvironmentLines({ apiKey, pathEntries, tritonAiEnvironment });

  fs.writeFileSync(paths.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  emit(`Saved private TritonAI Harness environment at ${paths.envFile}`);
}

function removeLegacyShellProfileIntegration(homeDir, envFile) {
  const marker = "# TritonAI environment";
  const sourceLine = `[ -f "${envFile}" ] && source "${envFile}"`;

  for (const profileName of [".zshrc", ".bashrc"]) {
    const profile = path.join(homeDir, profileName);
    if (!fs.existsSync(profile)) continue;

    const existing = fs.readFileSync(profile, "utf8");
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    const lines = existing.split(/\r?\n/);
    const kept = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === marker && lines[index + 1] === sourceLine) {
        index += 1;
        continue;
      }
      if (lines[index] === sourceLine) continue;
      kept.push(lines[index]);
    }

    const updated = kept.join(newline);
    if (updated !== existing) {
      fs.writeFileSync(profile, updated);
    }
  }
}

function runPowerShell(command, description) {
  return new Promise<void>((resolve, reject) => {
    const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell exited with code ${code} while ${description}`));
    });
  });
}

module.exports = {
  buildMacEnvironmentLines,
  buildWindowsEnvironmentCleanupScript,
  buildWindowsEnvironmentLines,
  powerShellLiteral,
  removeLegacyShellProfileIntegration,
  saveEnvironment
};
