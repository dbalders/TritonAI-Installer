const https = require("https");
const { UCSD } = require("./constants");

interface ConnectionResponse {
  statusCode: number;
  body: unknown;
}

interface RequestJsonOptions {
  url: URL;
  method?: string;
  apiKey: string;
  timeoutMs: number;
  body?: unknown;
}

async function checkTritonAiConnection({ apiKey, baseUrl = UCSD.baseUrl, timeoutMs = 10000 }) {
  if (!apiKey) {
    throw new Error("A TritonAI access key is required to check the connection.");
  }

  const response = await requestJson({
    url: modelsUrlForBase(baseUrl),
    apiKey,
    timeoutMs
  });

  assertConnectionResponse(response);
  let access = classifyModelAccess(response.body);
  const modelCatalogReported = response.body
    && typeof response.body === "object"
    && Array.isArray((response.body as { data?: unknown }).data);
  if (!modelCatalogReported) {
    const externalModelsEnabled = await canSendExternalModelMessage({
      apiKey,
      baseUrl,
      timeoutMs,
      model: UCSD.externalModelProbe
    });
    access = { onPrem: true, frontier: externalModelsEnabled };
  }

  return {
    ok: true,
    access,
    externalModelsEnabled: access.frontier
  };
}

function classifyModelAccess(body): { onPrem: boolean; frontier: boolean } {
  const record = body && typeof body === "object" ? body as { data?: unknown } : {};
  const data = Array.isArray(record.data) ? record.data : [];
  const modelIds = new Set<string>(data.flatMap((entry): string[] => {
    if (typeof entry === "string") return [entry];
    const model = entry && typeof entry === "object" ? entry as { id?: unknown } : {};
    if (typeof model.id === "string") return [model.id];
    return [];
  }));
  const access = { onPrem: false, frontier: false };
  for (const modelId of modelIds) {
    if (!Object.prototype.hasOwnProperty.call(UCSD.codexModels, modelId)) continue;
    access[UCSD.modelRoute(modelId) === "on-prem" ? "onPrem" : "frontier"] = true;
  }
  return access;
}

function assertConnectionResponse(response: ConnectionResponse) {
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new Error("TritonAI rejected the access key. Confirm the key is active, then try again.");
  }

  if (response.statusCode === 429) {
    throw new Error("TritonAI is reachable, but the request is currently rate limited. Wait a moment, then try again.");
  }

  if (response.statusCode >= 200 && response.statusCode < 300) {
    return;
  }

  throw new Error(`TritonAI connection check failed with HTTP ${response.statusCode}. Try again or check UC San Diego TritonAI status.`);
}

function modelsUrlForBase(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url;
}

function chatCompletionsUrlForBase(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url;
}

async function canSendExternalModelMessage({ apiKey, baseUrl, timeoutMs, model }) {
  try {
    const response = await requestJson({
      url: chatCompletionsUrlForBase(baseUrl),
      method: "POST",
      apiKey,
      timeoutMs,
      body: {
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content: "Reply with exactly OK."
          }
        ]
      }
    });
    return response.statusCode >= 200 && response.statusCode < 300;
  } catch {
    return false;
  }
}

function requestJson({ url, method = "GET", apiKey, timeoutMs, body }: RequestJsonOptions): Promise<ConnectionResponse> {
  return new Promise<ConnectionResponse>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const request = https.request(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "TritonAI-Installer",
        ...(payload ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      response.on("data", (chunk) => {
        const bytes = Buffer.from(chunk);
        byteLength += bytes.length;
        if (byteLength <= 1024 * 1024) chunks.push(bytes);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        let responseBody: unknown = null;
        if (text) {
          try {
            responseBody = JSON.parse(text);
          } catch {
            responseBody = null;
          }
        }
        resolve({ statusCode: response.statusCode || 0, body: responseBody });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("TritonAI connection check timed out. Check your internet connection, then try again."));
    });
    request.on("error", (error) => {
      reject(new Error(`TritonAI connection check failed: ${error.message}`));
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

module.exports = {
  checkTritonAiConnection,
  classifyModelAccess,
  modelsUrlForBase,
  chatCompletionsUrlForBase
};
