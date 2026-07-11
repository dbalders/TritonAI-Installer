const fs = require("fs");
const path = require("path");
const { UCSD } = require("./constants");
const { getTritonAiEnvironment } = require("./codex-environment");
const { prepareWindowsEnvironmentMigration } = require("./windows-environment-migration");

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

async function saveEnvironment({ apiKey, paths, platform, nodeRuntime, emit, windowsEnvironmentMigrationRuntime = {} }) {
  fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
  const pathEntries = [paths.binDir, paths.codexBinDir, paths.nodeGlobalBinDir, nodeRuntime && nodeRuntime.nodeBinDir].filter(Boolean);
  const tritonAiEnvironment = getTritonAiEnvironment(paths) as Record<string, string>;

  if (platform === "win32") {
    const migration = prepareWindowsEnvironmentMigration({ paths, ...windowsEnvironmentMigrationRuntime });
    const lines = buildWindowsEnvironmentLines({ apiKey, pathEntries, tritonAiEnvironment });

    fs.writeFileSync(paths.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
    emit(`Saved private TritonAI Harness environment at ${paths.envFile}`);
    return migration;
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

module.exports = {
  buildMacEnvironmentLines,
  buildWindowsEnvironmentLines,
  powerShellLiteral,
  removeLegacyShellProfileIntegration,
  saveEnvironment
};
