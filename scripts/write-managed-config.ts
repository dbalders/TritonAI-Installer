const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const outputPath = path.join(root, "build", "managed-config.generated.json");
const DEFAULT_API_DOCS_URL = "https://tritonai.ucsd.edu/developer-apis/start.html";

function createManagedConfig(env = process.env) {
  return {
    baseUrl: requiredUrl("UCSD_AI_BASE_URL", env),
    apiDocsUrl: normalizeUrl(
      "UCSD_AI_DOCS_URL",
      env.UCSD_AI_DOCS_URL || DEFAULT_API_DOCS_URL
    ),
    codexModel: env.UCSD_CODEX_MODEL || "api-deepseek-v4-flash",
    restrictedCodexModel: env.UCSD_RESTRICTED_CODEX_MODEL || "api-deepseek-v4-flash",
    externalModelProbe: env.UCSD_EXTERNAL_MODEL_PROBE || "gpt-5.6-sol"
  };
}

function main() {
  const config = createManagedConfig();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote managed config: ${path.relative(root, outputPath)}`);
}

function requiredUrl(name, env = process.env) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it before packaging the installer.`);
  }
  return normalizeUrl(name, value);
}

function normalizeUrl(name, value) {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_API_DOCS_URL,
  createManagedConfig
};
