const { NPM_POLICY, CODEX_CLI_VERSION } = require("./npm-policy");

const TOOLS = {
  t3code: {
    id: "t3code",
    name: "TritonAI Harness",
    recommended: true,
    description: "Desktop GUI for UCSD-managed Codex, backed by TritonAI.",
    install: {
      default: []
    },
    verify: [],
    configWriter: "writeT3CodeSettings"
  }
};

const CODEX_CLI = {
  id: "codex-cli",
  name: "TritonAI Codex backend",
  install: {
    default: [["npm", ["install", "-g", "--prefix", "{{codexInstallRoot}}", "--before", NPM_POLICY.cutoffDate, `@openai/codex@${CODEX_CLI_VERSION}`]]]
  },
  verify: [["{{codexBinary}}", ["--version"]]]
};

function getTool(id) {
  return TOOLS[id];
}

function listTools() {
  return Object.values(TOOLS);
}

function getInstallPreview(platform = process.platform) {
  const tool = TOOLS.t3code;
  const installsSupportComponents = getCommands(CODEX_CLI, "install", platform).length > 0;
  return {
    id: tool.id,
    name: tool.name,
    recommended: tool.recommended,
    description: tool.description,
    commands: [
      "Prepare TritonAI model access",
      ...(installsSupportComponents ? ["Install TritonAI support package"] : []),
      ...(platform === "darwin"
        ? ["Install bundled TritonAI Harness desktop app and create the launcher"]
        : []),
      ...(platform === "win32"
        ? ["Install bundled TritonAI Harness desktop app and create the launcher shortcut"]
        : [])
    ]
  };
}

function getCommands(tool, phase, platform = process.platform) {
  const phaseCommands = tool[phase] || {};
  return phaseCommands[platform] || phaseCommands.default || [];
}

module.exports = { getTool, listTools, getInstallPreview, getCommands, CODEX_CLI };
