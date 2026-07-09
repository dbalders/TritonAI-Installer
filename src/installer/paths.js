const os = require("os");
const path = require("path");
const { CODEX_CLI_VERSION } = require("./npm-policy");
const { INSTALLER_VERSION_MARKER_FILENAME } = require("./installer-version-marker");

function getPaths(homeDir = os.homedir(), platform = process.platform) {
  const agentsRoot = path.join(homeDir, ".agents");
  const ucsdRoot = path.join(agentsRoot, "ucsd");
  const isWindows = platform === "win32";
  const configDir = path.join(ucsdRoot, "config");
  const cacheDir = path.join(ucsdRoot, "cache");
  const dataDir = path.join(ucsdRoot, "data");
  const stateDir = path.join(ucsdRoot, "state");
  const tritonAiHome = path.join(homeDir, ".tritonai-harness");
  const codexInstallRoot = path.join(ucsdRoot, "runtime", "codex", `openai-codex-${CODEX_CLI_VERSION}`);

  return {
    platform,
    homeDir,
    agentsRoot,
    ucsdRoot,
    binDir: path.join(ucsdRoot, "bin"),
    configDir,
    cacheDir,
    dataDir,
    skillsDir: path.join(tritonAiHome, "codex", "skills"),
    logsDir: path.join(ucsdRoot, "logs"),
    policiesDir: path.join(ucsdRoot, "policies"),
    stateDir,
    runtimeDir: path.join(ucsdRoot, "runtime"),
    nodeRoot: path.join(ucsdRoot, "runtime", "node"),
    nodeGlobalRoot: path.join(ucsdRoot, "runtime", "node-global"),
    nodeGlobalBinDir: isWindows
      ? path.join(ucsdRoot, "runtime", "node-global")
      : path.join(ucsdRoot, "runtime", "node-global", "bin"),
    codexRoot: path.join(ucsdRoot, "runtime", "codex"),
    codexInstallRoot,
    codexBinDir: isWindows ? codexInstallRoot : path.join(codexInstallRoot, "bin"),
    codexHome: path.join(tritonAiHome, "codex"),
    sharedAgentsFile: path.join(ucsdRoot, "AGENTS.md"),
    onboardingWorkspaceDir: path.join(homeDir, "TritonAI"),
    onboardingWorkspaceMarker: path.join(ucsdRoot, "state", "onboarding-workspace-seeded"),
    installerVersionMarker: path.join(stateDir, INSTALLER_VERSION_MARKER_FILENAME),
    envFile: isWindows ? path.join(ucsdRoot, "env.ps1") : path.join(ucsdRoot, "env"),
    t3Home: tritonAiHome,
    t3Settings: path.join(tritonAiHome, "userdata", "settings.json"),
    t3DefaultsPatcher: path.join(ucsdRoot, "bin", "t3code-ucsd-defaults.js")
  };
}

module.exports = { getPaths };
