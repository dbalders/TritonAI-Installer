const assert = require("assert");

const { UCSD } = require("../src/installer/constants");
const {
  checkAndAssignCredentials,
  credentialEnvironment,
  credentialValues,
  normalizeCredentialBundle
} = require("../src/installer/credentials");
const { readCredentialsFromEnvText } = require("../src/installer/existing-api-key");
const {
  __test: {
    assertJsonResponseWithinLimit,
    MAX_JSON_RESPONSE_BYTES,
    probeFallbackModelAccess
  },
  classifyModelAccess
} = require("../src/installer/tritonai-connection");
const { buildMacEnvironmentLines, buildWindowsEnvironmentLines } = require("../src/installer/profile");
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
  assert.deepStrictEqual(credentialValues({
    onPremApiKey: "saved-on-prem",
    frontierApiKey: "saved-frontier"
  }), ["saved-on-prem", "saved-frontier"]);
  const supplemented = await checkAndAssignCredentials({
    apiKeys: ["saved-on-prem", "new-frontier"],
    checkConnection: async ({ apiKey }) => ({
      access: apiKey === "saved-on-prem"
        ? { onPrem: true, frontier: false }
        : { onPrem: false, frontier: true }
    })
  });
  assert.deepStrictEqual(supplemented.credentials, {
    onPremApiKey: "saved-on-prem",
    frontierApiKey: "new-frontier"
  });
  const environmentLines = buildMacEnvironmentLines({
    credentials: split.credentials,
    pathEntries: ["/managed/bin"],
    tritonAiEnvironment: { UCSD_AI_BASE_URL: "https://example.invalid/v1" }
  });
  assert(environmentLines.some((line) => line.includes("TRITONAI_ONPREM_API_KEY='on-prem-key'")));
  assert(environmentLines.some((line) => line.includes("TRITONAI_FRONTIER_API_KEY='frontier-key'")));
  assert(!environmentLines.some((line) => line.includes("TRITONAI_API_KEY=")));
  assert(environmentLines.includes(
    "unset TRITONAI_API_KEY TRITONAI_ONPREM_API_KEY TRITONAI_FRONTIER_API_KEY"
  ));
  const windowsEnvironmentLines = buildWindowsEnvironmentLines({
    credentials: split.credentials,
    pathEntries: ["C:\\managed\\bin"],
    tritonAiEnvironment: { UCSD_AI_BASE_URL: "https://example.invalid/v1" }
  });
  for (const name of [UCSD.apiKeyEnv, UCSD.onPremApiKeyEnv, UCSD.frontierApiKeyEnv]) {
    assert(windowsEnvironmentLines.includes(
      `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
    ));
  }

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
  assert.deepStrictEqual(
    await probeFallbackModelAccess(
      { apiKey: "frontier-key", baseUrl: "https://example.invalid/v1", timeoutMs: 1000 },
      async ({ model }) => model === UCSD.externalModelProbe
    ),
    { onPrem: false, frontier: true },
    "fallback probing must not grant on-prem access to a frontier-only key"
  );
  assert.deepStrictEqual(
    await probeFallbackModelAccess(
      { apiKey: "on-prem-key", baseUrl: "https://example.invalid/v1", timeoutMs: 1000 },
      async ({ model }) => model === UCSD.restrictedCodexModel
    ),
    { onPrem: true, frontier: false },
    "fallback probing must classify on-prem-only keys independently"
  );
  assert.doesNotThrow(() => assertJsonResponseWithinLimit(MAX_JSON_RESPONSE_BYTES));
  assert.throws(
    () => assertJsonResponseWithinLimit(MAX_JSON_RESPONSE_BYTES + 1),
    /unexpectedly large response/
  );

  console.log("Credential routing tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
