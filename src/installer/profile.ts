const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { UCSD } = require("./constants");
const { getTritonAiEnvironment } = require("./codex-environment");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildWindowsEnvironmentLines({ apiKey, paths, pathEntries, tritonAiEnvironment }) {
  return [
    `$env:PATH = ${powerShellLiteral(`${pathEntries.join(";")};`)} + $env:PATH`,
    ...Object.entries(tritonAiEnvironment).map(([name, value]) => `$env:${name} = ${powerShellLiteral(value)}`),
    `$env:${UCSD.codexHomeEnv} = ${powerShellLiteral(paths.codexHome)}`,
    apiKey ? `$env:${UCSD.apiKeyEnv} = ${powerShellLiteral(apiKey)}` : null
  ].filter(Boolean);
}

async function saveEnvironment({ apiKey, paths, platform, nodeRuntime, emit }) {
  fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
  const pathEntries = [paths.binDir, paths.codexBinDir, paths.nodeGlobalBinDir, nodeRuntime && nodeRuntime.nodeBinDir].filter(Boolean);
  const tritonAiEnvironment = getTritonAiEnvironment(paths) as Record<string, string>;

  if (platform === "win32") {
    const lines = buildWindowsEnvironmentLines({ apiKey, paths, pathEntries, tritonAiEnvironment });

    fs.writeFileSync(paths.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });

    for (const [name, value] of Object.entries(tritonAiEnvironment)) {
      await setWindowsEnv(name, value);
    }
    await setWindowsEnv(UCSD.codexHomeEnv, paths.codexHome);
    await updateWindowsPath(pathEntries);
    if (apiKey) {
      await setWindowsEnv(UCSD.apiKeyEnv, apiKey);
    }
    Object.assign(process.env, tritonAiEnvironment);
    process.env[UCSD.codexHomeEnv] = paths.codexHome;
    process.env.PATH = `${pathEntries.join(";")};${process.env.PATH || ""}`;
    if (apiKey) {
      process.env[UCSD.apiKeyEnv] = apiKey;
    }
    await broadcastWindowsEnvironmentChange(emit);

    emit(`Saved user environment variables and ${paths.envFile}`);
    return;
  }

  const lines = [
    `export PATH=${shellQuote(pathEntries.join(":"))}:$PATH`,
    ...Object.entries(tritonAiEnvironment).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `export ${UCSD.codexHomeEnv}=${shellQuote(paths.codexHome)}`,
    apiKey ? `export ${UCSD.apiKeyEnv}=${shellQuote(apiKey)}` : null
  ].filter(Boolean);

  fs.writeFileSync(paths.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  updateShellProfile(paths.homeDir, paths.envFile);
  emit(`Saved shell environment file at ${paths.envFile}`);
}

function updateShellProfile(homeDir, envFile) {
  const profile = process.env.SHELL && process.env.SHELL.includes("bash")
    ? path.join(homeDir, ".bashrc")
    : path.join(homeDir, ".zshrc");
  const marker = "# TritonAI environment";
  const line = `[ -f "${envFile}" ] && source "${envFile}"`;
  const block = `${marker}\n${line}`;
  const existing = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : "";

  if (!existing.includes(marker) && !existing.includes(line)) {
    fs.appendFileSync(profile, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${block}\n`);
  }
}

function setWindowsEnv(name, value) {
  return new Promise<void>((resolve, reject) => {
    const escaped = String(value).replaceAll("'", "''");
    const command = `[Environment]::SetEnvironmentVariable('${name}', '${escaped}', 'User')`;
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell exited with code ${code} while setting ${name}`));
    });
  });
}

async function updateWindowsPath(pathEntries) {
  const escapedEntries = pathEntries.map((entry) => entry.replaceAll("'", "''"));
  const command = `
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($current) { $parts = $current -split ';' }
foreach ($entry in @('${escapedEntries.join("','")}')) {
  if ($parts -notcontains $entry) { $parts = @($entry) + $parts }
}
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
`;
  await runPowerShell(command, "updating user PATH");
}

async function broadcastWindowsEnvironmentChange(emit: InstallerEmit = () => {}) {
  const command = `
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
`;

  try {
    await runPowerShell(command, "broadcasting environment update");
  } catch (error) {
    emit(`Could not broadcast Windows environment update; new apps may need a sign out/in before seeing env changes: ${error.message}`);
  }
}

function runPowerShell(command, description) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell exited with code ${code} while ${description}`));
    });
  });
}

module.exports = { buildWindowsEnvironmentLines, powerShellLiteral, saveEnvironment };
