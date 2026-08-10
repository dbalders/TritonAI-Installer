const assert = require("assert");

const { UCSD } = require("../src/installer/constants");
const {
  checkAndAssignCredentials,
  credentialEnvironment,
  normalizeCredentialBundle
} = require("../src/installer/credentials");
const { readCredentialsFromEnvText } = require("../src/installer/existing-api-key");
const { classifyModelAccess } = require("../src/installer/tritonai-connection");
const { buildMacEnvironmentLines } = require("../src/installer/profile");
const { buildEnv } = require("../src/installer/runner");

async function main() {
  const combined = await checkAndAssignCredentials({
    apiKeys: ["combined-key"],
    checkConnection: async () => ({ access: { onPrem: true, frontier: true } })
  });
  assert.deepStrictEqual(combined.credentials, { sharedApiKey: "combined-key" });

  const split = await checkAndAssignCredentials({
    apiKeys: ["frontier-key", "on-prem-key"],
    checkConnection: async ({ apiKey }) => ({
      access: apiKey === "frontier-key"
        ? { onPrem: false, frontier: true }
        : { onPrem: true, frontier: false }
    })
  });
  assert.deepStrictEqual(split.credentials, {
    onPremApiKey: "on-prem-key",
    frontierApiKey: "frontier-key"
  });
  assert.deepStrictEqual(credentialEnvironment(split.credentials), {
    [UCSD.onPremApiKeyEnv]: "on-prem-key",
    [UCSD.frontierApiKeyEnv]: "frontier-key"
  });
  const environmentLines = buildMacEnvironmentLines({
    credentials: split.credentials,
    pathEntries: ["/managed/bin"],
    tritonAiEnvironment: { UCSD_AI_BASE_URL: "https://example.invalid/v1" }
  });
  assert(environmentLines.some((line) => line.includes("TRITONAI_ONPREM_API_KEY='on-prem-key'")));
  assert(environmentLines.some((line) => line.includes("TRITONAI_FRONTIER_API_KEY='frontier-key'")));
  assert(!environmentLines.some((line) => line.includes("TRITONAI_API_KEY=")));

  const inheritedCredentials = {
    [UCSD.apiKeyEnv]: process.env[UCSD.apiKeyEnv],
    [UCSD.onPremApiKeyEnv]: process.env[UCSD.onPremApiKeyEnv],
    [UCSD.frontierApiKeyEnv]: process.env[UCSD.frontierApiKeyEnv]
  };
  try {
    process.env[UCSD.apiKeyEnv] = "stale-shared-key";
    process.env[UCSD.onPremApiKeyEnv] = "stale-on-prem-key";
    process.env[UCSD.frontierApiKeyEnv] = "stale-frontier-key";
    const childEnvironment = buildEnv(
      { frontierApiKey: "current-frontier-key" },
      {
        binDir: "/managed/bin",
        codexBinDir: "/managed/codex/bin",
        nodeGlobalBinDir: "/managed/node/bin",
        codexHome: "/managed/codex/home",
        tritonAiHome: "/managed/tritonai/home"
      },
      null,
      "darwin"
    );
    assert.strictEqual(childEnvironment[UCSD.frontierApiKeyEnv], "current-frontier-key");
    assert.strictEqual(childEnvironment[UCSD.apiKeyEnv], undefined);
    assert.strictEqual(childEnvironment[UCSD.onPremApiKeyEnv], undefined);
  } finally {
    for (const [name, value] of Object.entries(inheritedCredentials)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.deepStrictEqual(
    normalizeCredentialBundle({ apiKey: " shared ", onPremApiKey: "ignored" }),
    { sharedApiKey: "shared" }
  );
  assert.deepStrictEqual(
    readCredentialsFromEnvText([
      "export TRITONAI_ONPREM_API_KEY='local-key'",
      "$env:TRITONAI_FRONTIER_API_KEY = 'frontier-key'"
    ].join("\n")),
    { onPremApiKey: "local-key", frontierApiKey: "frontier-key" }
  );

  assert.deepStrictEqual(classifyModelAccess({
    data: [{ id: "api-deepseek-v4-flash" }, { id: "gpt-5.6-sol" }]
  }), { onPrem: true, frontier: true });
  assert.deepStrictEqual(classifyModelAccess({
    data: [{ id: "api-glm-5.2" }]
  }), { onPrem: true, frontier: false });

  console.log("Credential routing tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
