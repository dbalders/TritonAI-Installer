const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const outputPath = path.join(root, "build", "managed-config.generated.json");

function main() {
  const config = {
    baseUrl: requiredUrl("UCSD_AI_BASE_URL"),
    apiDocsUrl: optionalUrl("UCSD_AI_DOCS_URL"),
    codexModel: process.env.UCSD_CODEX_MODEL || "api-deepseek-v4-flash",
    restrictedCodexModel: process.env.UCSD_RESTRICTED_CODEX_MODEL || "api-deepseek-v4-flash",
    externalModelProbe: process.env.UCSD_EXTERNAL_MODEL_PROBE || "gpt-5.5"
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote managed config: ${path.relative(root, outputPath)}`);
}

function requiredUrl(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it before packaging the installer.`);
  }
  return normalizeUrl(name, value);
}

function optionalUrl(name) {
  const value = process.env[name];
  return value ? normalizeUrl(name, value) : "";
}

function normalizeUrl(name, value) {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

main();
