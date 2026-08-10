const fs = require("fs");
const { spawn } = require("child_process");
const { UCSD } = require("./constants");
const { getPaths } = require("./paths");
const { terminateProcessTree } = require("./process-termination");

const API_KEY_ENV_NAMES = [UCSD.apiKeyEnv, UCSD.onPremApiKeyEnv, UCSD.frontierApiKeyEnv];

type WindowsEnvironmentReader = (name: string, scope: "User" | "Machine") => Promise<string>;

async function findExistingCredentials({
  homeDir,
  platform = process.platform,
  env = process.env,
  windowsEnvReader = readWindowsEnvironmentVariable
}: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  windowsEnvReader?: WindowsEnvironmentReader;
} = {}) {
  const processCredentials = readCredentialsFromEnvironment(env || {});
  if (hasCredentials(processCredentials)) {
    return { credentials: processCredentials, source: "processEnvironment" };
  }

  if (platform === "win32") {
    const userCredentials = await readWindowsCredentials("User", windowsEnvReader);
    if (hasCredentials(userCredentials)) {
      return { credentials: userCredentials, source: "windowsUserEnvironment" };
    }

    const machineCredentials = await readWindowsCredentials("Machine", windowsEnvReader);
    if (hasCredentials(machineCredentials)) {
      return { credentials: machineCredentials, source: "windowsMachineEnvironment" };
    }
  }

  const paths = getPaths(homeDir, platform);
  const fileCredentials = readCredentialsFromEnvFile(paths.envFile);
  return hasCredentials(fileCredentials)
    ? { credentials: fileCredentials, source: "installerEnvFile" }
    : null;
}

async function findExistingApiKey(options = {}): Promise<ExistingApiKey | null> {
  const existing = await findExistingCredentials(options);
  if (!existing) return null;
  const apiKey = existing.credentials.sharedApiKey
    || existing.credentials.onPremApiKey
    || existing.credentials.frontierApiKey;
  return apiKey ? { apiKey, source: existing.source } : null;
}

function readCredentialsFromEnvironment(environment): TritonAiCredentials {
  const sharedApiKey = normalizeApiKey(environment[UCSD.apiKeyEnv]);
  if (sharedApiKey) return { sharedApiKey };
  const onPremApiKey = normalizeApiKey(environment[UCSD.onPremApiKeyEnv]);
  const frontierApiKey = normalizeApiKey(environment[UCSD.frontierApiKeyEnv]);
  return {
    ...(onPremApiKey ? { onPremApiKey } : {}),
    ...(frontierApiKey ? { frontierApiKey } : {})
  };
}

async function readWindowsCredentials(scope, windowsEnvReader) {
  const values = await Promise.all(
    API_KEY_ENV_NAMES.map(async (name) => [name, await windowsEnvReader(name, scope)])
  );
  return readCredentialsFromEnvironment(Object.fromEntries(values));
}

function hasCredentials(credentials: TritonAiCredentials) {
  return Boolean(credentials.sharedApiKey || credentials.onPremApiKey || credentials.frontierApiKey);
}

function readApiKeyFromEnvFile(envFile) {
  const credentials = readCredentialsFromEnvFile(envFile);
  return credentials.sharedApiKey || credentials.onPremApiKey || credentials.frontierApiKey || "";
}

function readApiKeyFromEnvText(content) {
  const credentials = readCredentialsFromEnvText(content);
  return credentials.sharedApiKey || credentials.onPremApiKey || credentials.frontierApiKey || "";
}

function readCredentialsFromEnvFile(envFile): TritonAiCredentials {
  if (!envFile || !fs.existsSync(envFile)) return {};
  return readCredentialsFromEnvText(fs.readFileSync(envFile, "utf8"));
}

function readCredentialsFromEnvText(content): TritonAiCredentials {
  const environment: Record<string, string> = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+|\$env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/i);
    if (!match) continue;
    const name = API_KEY_ENV_NAMES.find((candidate) => candidate.toUpperCase() === match[1].toUpperCase());
    if (name) environment[name] = parseAssignmentValue(match[2]);
  }
  return readCredentialsFromEnvironment(environment);
}

function parseAssignmentValue(value) {
  const trimmed = String(value || "").trim().replace(/;$/, "").trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("'\\''", "'");
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }

  return trimmed.replace(/\s+#.*$/, "");
}

function readWindowsEnvironmentVariable(
  name: string,
  scope: "User" | "Machine",
  {
    timeoutMs = 4_000,
    spawnProcess = spawn,
    terminate = terminateProcessTree
  } = {}
): Promise<string> {
  return new Promise<string>((resolve) => {
    const escapedName = String(name).replaceAll("'", "''");
    const escapedScope = String(scope).replaceAll("'", "''");
    const child = spawnProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${escapedName}', '${escapedScope}')`
    ], {
      windowsHide: true
    });
    let stdout = "";
    let settled = false;
    let timingOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled || timingOut) return;
      timingOut = true;
      void terminate(child, { platform: "win32" }).then(
        () => finish(""),
        (error) => {
          console.error(`Could not terminate timed-out Windows environment lookup: ${error.message}`);
          finish("");
        }
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      if (!timingOut) finish("");
    });
    child.on("close", () => {
      if (!timingOut) finish(stdout.trim());
    });
  });
}

function normalizeApiKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  findExistingCredentials,
  findExistingApiKey,
  readWindowsEnvironmentVariable,
  readApiKeyFromEnvFile,
  readApiKeyFromEnvText,
  readCredentialsFromEnvFile,
  readCredentialsFromEnvText,
  parseAssignmentValue
};
