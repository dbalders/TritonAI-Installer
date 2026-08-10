const { UCSD } = require("./constants");

interface CredentialAccess {
  onPrem: boolean;
  frontier: boolean;
}

interface CredentialCheckResult {
  key: string;
  keyIndex: number;
  access: CredentialAccess;
}

function normalizeApiKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCredentialBundle(
  input: TritonAiCredentials & { apiKey?: unknown } = {}
): TritonAiCredentials {
  const sharedApiKey = normalizeApiKey(input.sharedApiKey || input.apiKey);
  if (sharedApiKey) return { sharedApiKey };

  const onPremApiKey = normalizeApiKey(input.onPremApiKey);
  const frontierApiKey = normalizeApiKey(input.frontierApiKey);
  return {
    ...(onPremApiKey ? { onPremApiKey } : {}),
    ...(frontierApiKey ? { frontierApiKey } : {})
  };
}

function credentialEnvironment(credentials: TritonAiCredentials): Record<string, string> {
  const normalized = normalizeCredentialBundle(credentials);
  if (normalized.sharedApiKey) {
    return { [UCSD.apiKeyEnv]: normalized.sharedApiKey };
  }
  return {
    ...(normalized.onPremApiKey ? { [UCSD.onPremApiKeyEnv]: normalized.onPremApiKey } : {}),
    ...(normalized.frontierApiKey ? { [UCSD.frontierApiKeyEnv]: normalized.frontierApiKey } : {})
  };
}

function credentialValues(credentials: TritonAiCredentials): string[] {
  return [...new Set(Object.values(credentialEnvironment(credentials)))];
}

function primaryApiKey(credentials: TritonAiCredentials): string {
  const normalized = normalizeCredentialBundle(credentials);
  return normalized.sharedApiKey || normalized.onPremApiKey || normalized.frontierApiKey || "";
}

function normalizeAccess(result): CredentialAccess {
  if (result && result.access) {
    return {
      onPrem: result.access.onPrem === true,
      frontier: result.access.frontier === true
    };
  }
  return {
    onPrem: true,
    frontier: result && result.externalModelsEnabled === true
  };
}

function assignCheckedCredentials(results: CredentialCheckResult[]) {
  const onPremOnly = results.find((result) => result.access.onPrem && !result.access.frontier);
  const frontierOnly = results.find((result) => result.access.frontier && !result.access.onPrem);
  const onPrem = onPremOnly || results.find((result) => result.access.onPrem);
  const frontier = frontierOnly
    || [...results].reverse().find((result) => result.access.frontier);

  if (!onPrem && !frontier) {
    throw new Error("These keys are active, but they do not include access to TritonAI Harness models.");
  }

  if (onPrem && frontier && onPrem.key === frontier.key) {
    return {
      credentials: { sharedApiKey: onPrem.key },
      access: { onPrem: true, frontier: true },
      assignments: { onPremKeyIndex: onPrem.keyIndex, frontierKeyIndex: frontier.keyIndex }
    };
  }

  return {
    credentials: {
      ...(onPrem ? { onPremApiKey: onPrem.key } : {}),
      ...(frontier ? { frontierApiKey: frontier.key } : {})
    },
    access: { onPrem: Boolean(onPrem), frontier: Boolean(frontier) },
    assignments: {
      ...(onPrem ? { onPremKeyIndex: onPrem.keyIndex } : {}),
      ...(frontier ? { frontierKeyIndex: frontier.keyIndex } : {})
    }
  };
}

async function checkAndAssignCredentials({
  apiKeys,
  checkConnection,
  baseUrl,
  timeoutMs = 10000
}: {
  apiKeys: unknown[];
  checkConnection: (input: { apiKey: string; baseUrl?: string; timeoutMs: number }) => Promise<unknown>;
  baseUrl?: string;
  timeoutMs?: number;
}) {
  const keys = [...new Set((apiKeys || []).map(normalizeApiKey).filter(Boolean))];
  if (keys.length === 0) {
    throw new Error("A TritonAI access key is required to continue.");
  }
  if (keys.length > 2) {
    throw new Error("TritonAI Harness supports up to two access keys.");
  }

  const checked: CredentialCheckResult[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    try {
      const result = await checkConnection({ apiKey: keys[index], baseUrl, timeoutMs });
      checked.push({ key: keys[index], keyIndex: index, access: normalizeAccess(result) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const label = keys.length === 1 ? "access key" : `access key ${index + 1}`;
      throw new Error(`Could not verify ${label}. ${message}`);
    }
  }

  return assignCheckedCredentials(checked);
}

module.exports = {
  assignCheckedCredentials,
  checkAndAssignCredentials,
  credentialEnvironment,
  credentialValues,
  normalizeCredentialBundle,
  primaryApiKey
};
