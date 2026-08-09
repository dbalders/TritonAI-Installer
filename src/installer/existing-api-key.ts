const fs = require("fs");
const { spawn } = require("child_process");
const { UCSD } = require("./constants");
const { getPaths } = require("./paths");
const { terminateProcessTree } = require("./process-termination");

const API_KEY_ASSIGNMENT_PATTERN = (() => {
  const name = escapeRegExp(UCSD.apiKeyEnv);
  return new RegExp(`^\\s*(?:export\\s+|\\$env:)?${name}\\s*=\\s*(.+?)\\s*$`, "i");
})();

type WindowsEnvironmentReader = (name: string, scope: "User" | "Machine") => Promise<string>;

async function findExistingApiKey({
  homeDir,
  platform = process.platform,
  env = process.env,
  windowsEnvReader = readWindowsEnvironmentVariable
}: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  windowsEnvReader?: WindowsEnvironmentReader;
} = {}): Promise<ExistingApiKey | null> {
  const processValue = normalizeApiKey(env && env[UCSD.apiKeyEnv]);
  if (processValue) {
    return { apiKey: processValue, source: "processEnvironment" };
  }

  if (platform === "win32") {
    const userValue = normalizeApiKey(await windowsEnvReader(UCSD.apiKeyEnv, "User"));
    if (userValue) {
      return { apiKey: userValue, source: "windowsUserEnvironment" };
    }

    const machineValue = normalizeApiKey(await windowsEnvReader(UCSD.apiKeyEnv, "Machine"));
    if (machineValue) {
      return { apiKey: machineValue, source: "windowsMachineEnvironment" };
    }
  }

  const paths = getPaths(homeDir, platform);
  const fileValue = normalizeApiKey(readApiKeyFromEnvFile(paths.envFile));
  return fileValue ? { apiKey: fileValue, source: "installerEnvFile" } : null;
}

function readApiKeyFromEnvFile(envFile) {
  if (!envFile || !fs.existsSync(envFile)) {
    return "";
  }

  const content = fs.readFileSync(envFile, "utf8");
  return readApiKeyFromEnvText(content);
}

function readApiKeyFromEnvText(content) {
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(API_KEY_ASSIGNMENT_PATTERN);
    if (!match) continue;
    return parseAssignmentValue(match[1]);
  }

  return "";
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  findExistingApiKey,
  readWindowsEnvironmentVariable,
  readApiKeyFromEnvFile,
  readApiKeyFromEnvText,
  parseAssignmentValue
};
