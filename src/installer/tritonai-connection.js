const https = require("https");
const { UCSD } = require("./constants");

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

  const externalModelsEnabled = await canSendExternalModelMessage({
    apiKey,
    baseUrl,
    timeoutMs,
    model: UCSD.externalModelProbe
  });

  return {
    ok: true,
    externalModelsEnabled
  };
}

function assertConnectionResponse(response) {
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

function requestJson({ url, method = "GET", apiKey, timeoutMs, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const request = https.request(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "UCSD-AI-Tools-Installer",
        ...(payload ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        } : {})
      }
    }, (response) => {
      response.resume();
      response.on("end", () => {
        resolve({ statusCode: response.statusCode || 0 });
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

module.exports = { checkTritonAiConnection, modelsUrlForBase, chatCompletionsUrlForBase };
