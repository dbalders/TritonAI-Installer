const fs = require("fs");
const os = require("os");
const path = require("path");
const { CODEX_CLI_VERSION } = require("./npm-policy");

const REPORT_VERSION = 1;
const MAX_REPORT_EVENTS = 200;

function createDiagnosticsSession({
  paths,
  platform = process.platform,
  arch = process.arch,
  installerVersion = "unknown",
  secretValues = []
}) {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const stamp = timestampForFile(new Date());
  const logFile = path.join(paths.logsDir, `installer-${stamp}.log`);
  const supportReportFile = path.join(paths.logsDir, `support-report-${stamp}.json`);
  const events = [];
  let currentStep = "start";
  fs.writeFileSync(logFile, `[${new Date().toISOString()}] [start] Installer diagnostics started${os.EOL}`);

  function redact(value) {
    return redactSensitive(value, secretValues);
  }

  function append(message) {
    const redacted = redact(message);
    events.push({
      time: new Date().toISOString(),
      step: currentStep,
      message: redacted
    });
    fs.appendFileSync(logFile, `[${events[events.length - 1].time}] [${currentStep}] ${redacted}${os.EOL}`);
  }

  function setStep(step) {
    currentStep = step || currentStep;
  }

  function writeSupportReport({
    ok,
    error = null,
    nodeRuntime = null,
    desktopApps = {},
    extra = {}
  } = {}) {
    const report = {
      reportVersion: REPORT_VERSION,
      generatedAt: new Date().toISOString(),
      ok: Boolean(ok),
      failedStep: ok ? null : currentStep,
      installer: {
        version: installerVersion,
        platform,
        arch
      },
      paths: {
        ucsdRoot: paths.ucsdRoot,
        logsDir: paths.logsDir,
        logFile,
        supportReportFile,
        envFile: paths.envFile,
        tritonAiHome: paths.t3Home,
        codexHome: paths.codexHome,
        t3Settings: paths.t3Settings,
        onboardingWorkspace: paths.onboardingWorkspaceDir,
        codexBinaryPath: paths.codexBinaryPath || path.join(paths.codexBinDir, platform === "win32" ? "codex.cmd" : "codex")
      },
      runtime: {
        node: nodeRuntime && nodeRuntime.nodeBinary,
        npm: nodeRuntime && nodeRuntime.npmBinary,
        codexCliVersion: CODEX_CLI_VERSION
      },
      desktopApps,
      error: error ? serializeError(error, redact) : null,
      events: events.slice(-MAX_REPORT_EVENTS),
      ...extra
    };

    fs.writeFileSync(supportReportFile, `${JSON.stringify(report, null, 2)}${os.EOL}`);
    return {
      logsDir: paths.logsDir,
      logFile,
      supportReportFile,
      failedStep: report.failedStep,
      ok: report.ok
    };
  }

  return {
    logFile,
    supportReportFile,
    logsDir: paths.logsDir,
    append,
    setStep,
    writeSupportReport
  };
}

function serializeError(error, redact) {
  return {
    name: error.name || "Error",
    message: redact(error.message || String(error)),
    code: error.code || null,
    stack: error.stack ? redact(error.stack) : null
  };
}

function redactSensitive(value, secretValues = []) {
  let output = String(value == null ? "" : value);
  for (const secret of secretValues.filter(Boolean)) {
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
  }
  return output
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/(TRITONAI_API_KEY\s*[:=]\s*)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/(["']?apiKey["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1[redacted]")
    .replace(/(["']?api_key["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1[redacted]")
    .replace(/(["']?accessKey["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1[redacted]");
}

function timestampForFile(date) {
  return date.toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  createDiagnosticsSession,
  redactSensitive
};
