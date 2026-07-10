const fs = require("fs");
const path = require("path");
const { defaultAppRoot } = require("./app-root");

const MANAGED_CONFIG_FILE = "managed-config.json";
const DEFAULT_BASE_URL = "https://example.invalid/v1";
const DEFAULT_CODEX_MODEL = "deepseek-v4-flash";
const DEFAULT_CODEX_MODELS = {
  [DEFAULT_CODEX_MODEL]: {
    id: DEFAULT_CODEX_MODEL,
    name: "DeepSeek v4 Flash"
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "GPT-5.5"
  },
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8"
  }
};

let cachedManagedConfig = null;

const UCSD = {
  apiKeyEnv: "TRITONAI_API_KEY",
  baseUrlEnv: "UCSD_AI_BASE_URL",
  docsUrlEnv: "UCSD_AI_DOCS_URL",
  allowEnvConfigEnv: "UCSD_ALLOW_MANAGED_CONFIG_ENV",
  managedConfigPathEnv: "UCSD_MANAGED_CONFIG_PATH",
  tritonAiHomeEnv: "TRITONAI_HOME",
  codexHomeEnv: "CODEX_HOME",
  codexProvider: "ucsd",
  get baseUrl() {
    return getManagedConfig().baseUrl;
  },
  get apiDocsUrl() {
    return getManagedConfig().apiDocsUrl;
  },
  get codexModel() {
    return getManagedConfig().codexModel;
  },
  get externalModelProbe() {
    return getManagedConfig().externalModelProbe;
  },
  get codexModels() {
    return getManagedConfig().codexModels;
  }
};

function getManagedConfig() {
  if (!cachedManagedConfig) {
    cachedManagedConfig = normalizeManagedConfig({
      ...readManagedConfigFile(),
      ...readManagedConfigEnvOverrides()
    });
  }
  return cachedManagedConfig;
}

function resetManagedConfigForTests() {
  cachedManagedConfig = null;
}

function readManagedConfigEnvOverrides() {
  if (!allowsEnvManagedConfig()) {
    return {};
  }

  return compactObject({
    baseUrl: process.env[UCSD.baseUrlEnv],
    apiDocsUrl: process.env[UCSD.docsUrlEnv],
    codexModel: process.env.UCSD_CODEX_MODEL,
    externalModelProbe: process.env.UCSD_EXTERNAL_MODEL_PROBE
  });
}

function readManagedConfigFile() {
  for (const configPath of getManagedConfigPaths()) {
    if (!configPath || !fs.existsSync(configPath)) continue;
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  return {};
}

function getManagedConfigPaths() {
  return [
    allowsEnvManagedConfig() && process.env[UCSD.managedConfigPathEnv],
    process.resourcesPath && path.join(process.resourcesPath, MANAGED_CONFIG_FILE),
    path.join(defaultAppRoot(__dirname), MANAGED_CONFIG_FILE)
  ];
}

function allowsEnvManagedConfig() {
  return process.env[UCSD.allowEnvConfigEnv] === "1";
}

function normalizeManagedConfig(config) {
  const codexModel = config.codexModel || DEFAULT_CODEX_MODEL;
  return {
    baseUrl: normalizeUrl(config.baseUrl || DEFAULT_BASE_URL),
    apiDocsUrl: normalizeOptionalUrl(config.apiDocsUrl),
    codexModel,
    externalModelProbe: config.externalModelProbe || "gpt-5.5",
    codexModels: normalizeCodexModels(config.codexModels, codexModel)
  };
}

function normalizeCodexModels(codexModels, codexModel) {
  if (codexModels && typeof codexModels === "object" && !Array.isArray(codexModels)) {
    // An explicit managed catalog is an operator policy override. Preserve it
    // exactly; key capability gating may narrow this catalog but must not add
    // models that the packaged policy intentionally omitted.
    if (!Object.prototype.hasOwnProperty.call(codexModels, codexModel)) {
      throw new Error(`Managed config codexModels must include the configured default model: ${codexModel}`);
    }
    return codexModels;
  }
  if (codexModel === DEFAULT_CODEX_MODEL) {
    return DEFAULT_CODEX_MODELS;
  }
  const customEntry = Object.prototype.hasOwnProperty.call(DEFAULT_CODEX_MODELS, codexModel)
    ? {}
    : {
        [codexModel]: {
          id: codexModel,
          name: codexModel
        }
      };
  return {
    ...DEFAULT_CODEX_MODELS,
    ...customEntry
  };
}

function normalizeUrl(value) {
  return new URL(value).toString().replace(/\/$/, "");
}

function normalizeOptionalUrl(value) {
  return value ? new URL(value).toString() : "";
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")
  );
}

module.exports = {
  UCSD,
  getManagedConfig,
  resetManagedConfigForTests
};
