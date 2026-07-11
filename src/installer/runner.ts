const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getPaths } = require("./paths");
const { saveEnvironment } = require("./profile");
const { CODEX_CLI_VERSION } = require("./npm-policy");
const { getTool, getCommands, CODEX_CLI } = require("./tool-manifest");
const { ensurePrerequisites } = require("./prerequisites");
const { installT3CodeDesktop } = require("./t3code-desktop");
const { installBundledSkills } = require("./skills");
const { installBundledCodexCli } = require("./codex-vendor");
const { checkTritonAiConnection } = require("./tritonai-connection");
const { getTritonAiEnvironment } = require("./codex-environment");
const configWriters = require("./config-writers");
const { UCSD } = require("./constants");
const { createDiagnosticsSession } = require("./diagnostics");
const { defaultAppRoot } = require("./app-root");
const { writeInstallerVersionMarker } = require("./installer-version-marker");
const { version: packageInstallerVersion } = require(path.join(defaultAppRoot(__dirname), "package.json"));

async function runInstall(payload, runtime) {
  const apiKey = payload && typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  runtime = runtime || {};
  const platform = runtime.platform || process.platform;
  const arch = runtime.arch || process.arch;
  const paths = getPaths(runtime.homeDir, platform);
  paths.tritonAiApiKey = apiKey;
  const diagnostics = createDiagnosticsSession({
    paths,
    platform,
    arch,
    installerVersion: runtime.installerVersion,
    secretValues: [apiKey]
  });
  const emit = createDiagnosticEmitter(runtime.emit || (() => {}), diagnostics);
  const desktopApps: DesktopApps = {};
  let nodeRuntime = null;
  let environmentMigration = null;

  try {
    if (!apiKey) {
      diagnostics.setStep("connect");
      throw new Error("A TritonAI access key is required to install TritonAI Harness.");
    }
    const shouldSeedOnboardingWorkspace = isFreshInstall(paths);

    diagnostics.setStep("prepare");
    emit("Creating UCSD agent folders...");
    configWriters.ensureBaseFolders(paths);
    const skillsInstaller = runtime.installBundledSkills || installBundledSkills;
    skillsInstaller({
      paths,
      emit,
      resourcesPath: runtime.resourcesPath,
      appRoot: runtime.appRoot
    });
    if (shouldSeedOnboardingWorkspace) {
      emit("Creating first-run TritonAI workspace...");
      configWriters.seedOnboardingWorkspace(paths);
    }

    emit("Checking installer prerequisites...");
    const prerequisiteProvider = runtime.ensurePrerequisites || ensurePrerequisites;
    nodeRuntime = await prerequisiteProvider({
      paths,
      platform,
      arch,
      emit
    });

    diagnostics.setStep("connect");
    const connection = await verifyTritonAiConnection({ apiKey, runtime, emit });
    paths.externalModelsEnabled = connection.externalModelsEnabled;

    emit("Saving TritonAI access key environment...");
    const environmentSaver = runtime.saveEnvironment || saveEnvironment;
    environmentMigration = await environmentSaver({
      apiKey,
      paths,
      platform,
      nodeRuntime,
      emit,
      windowsEnvironmentMigrationRuntime: runtime.windowsEnvironmentMigrationRuntime
    });

    diagnostics.setStep("tools");
    const tool = getTool("t3code");
    await ensureCodexCliForT3({ apiKey, paths, nodeRuntime, runtime: { ...runtime, platform, arch }, emit });

    emit(`Configuring ${tool.name} for UCSD routing...`);
    configWriters[tool.configWriter](paths);
    await runT3DefaultsPatcher({ apiKey, paths, nodeRuntime, runtime: { ...runtime, platform, arch }, emit });

    diagnostics.setStep("shortcut");
    const desktopInstaller = runtime.installT3CodeDesktop || installT3CodeDesktop;
    emit("Installing TritonAI Harness desktop app...");
    const result = await installOptionalDesktopApp({
      desktopInstaller,
      paths,
      platform,
      arch,
      emit,
      resourcesPath: runtime.resourcesPath,
      appRoot: runtime.appRoot,
      packaged: runtime.packaged,
      env: buildEnv(apiKey, paths, nodeRuntime, platform)
    });
    if (result && result.appPath) {
      desktopApps.t3code = result.appPath;
    }
    if (result && result.shortcutPath) {
      desktopApps.t3codeShortcut = result.shortcutPath;
    }
    if (result && result.launcherPath) {
      desktopApps.t3codeLauncher = result.launcherPath;
    }

    diagnostics.setStep("verify");
    const diagnosticsInfo = diagnostics.writeSupportReport({
      ok: true,
      nodeRuntime,
      desktopApps
    });
    const response = {
      ok: true,
      paths: {
        ucsdRoot: paths.ucsdRoot,
        envFile: paths.envFile,
        codexHome: paths.codexHome,
        t3Settings: paths.t3Settings,
        onboardingWorkspace: paths.onboardingWorkspaceDir,
        logsDir: paths.logsDir
      },
      runtime: {
        node: nodeRuntime.nodeBinary,
        npm: nodeRuntime.npmBinary
      },
      desktopApps,
      diagnostics: diagnosticsInfo
    };
    if (runtime.onDiagnostics) runtime.onDiagnostics(diagnosticsInfo);
    const markerWriter = runtime.writeInstallerVersionMarker || writeInstallerVersionMarker;
    markerWriter({
      paths,
      installerVersion: runtime.installerVersion || packageInstallerVersion
    });
    emit("Recorded the installed TritonAI Installer version.");
    emit("Install flow finished.");
    if (environmentMigration && typeof environmentMigration.finalize === "function") {
      emit("Removing recorded legacy TritonAI user environment variables...");
      await environmentMigration.finalize();
    }
    return response;
  } catch (error) {
    const diagnosticsInfo = diagnostics.writeSupportReport({
      ok: false,
      error,
      nodeRuntime,
      desktopApps
    });
    error.diagnostics = diagnosticsInfo;
    if (runtime.onDiagnostics) runtime.onDiagnostics(diagnosticsInfo);
    throw error;
  }
}

function createDiagnosticEmitter(forward, diagnostics) {
  return (message) => {
    diagnostics.append(message);
    forward(message);
  };
}

function isFreshInstall(paths) {
  return !fs.existsSync(paths.onboardingWorkspaceMarker)
    && !fs.existsSync(paths.sharedAgentsFile)
    && !fs.existsSync(paths.t3Settings);
}

async function ensureCodexCliForT3({ apiKey, paths, nodeRuntime, runtime, emit }) {
  const managedBinary = managedCodexBinary(paths, runtime.platform);
  const managedVersion = isExecutable(managedBinary, runtime.platform)
    ? await getCodexVersionForRuntime({
        binary: managedBinary,
        env: buildEnv(apiKey, paths, nodeRuntime, runtime.platform),
        platform: runtime.platform,
        runtime,
        emit
      })
    : null;

  if (managedVersion !== CODEX_CLI_VERSION) {
    emit(managedVersion
      ? `Found managed Codex ${managedVersion}; installing managed Codex ${CODEX_CLI_VERSION} for TritonAI Harness.`
      : `Installing managed Codex ${CODEX_CLI_VERSION} for TritonAI Harness.`);
    await installManagedCodexCli({ apiKey, paths, nodeRuntime, runtime, emit });
    await verifyManagedCodexCli({ apiKey, paths, nodeRuntime, runtime, emit });
  } else {
    paths.codexBinaryPath = managedBinary;
    emit(`Found managed Codex ${managedVersion}; using it for TritonAI Harness.`);
  }

  emit("Verifying TritonAI Codex backend...");
  await runCommands(CODEX_CLI.verify, {
    emit,
    env: buildEnv(apiKey, paths, nodeRuntime, runtime.platform),
    paths,
    nodeRuntime,
    commandRunner: runtime.commandRunner,
    allowFailure: true
  });
}

async function verifyManagedCodexCli({ apiKey, paths, nodeRuntime, runtime, emit }) {
  const managedBinary = managedCodexBinary(paths, runtime.platform);
  const installedVersion = await getCodexVersionForRuntime({
    binary: managedBinary,
    env: buildEnv(apiKey, paths, nodeRuntime, runtime.platform),
    platform: runtime.platform,
    runtime,
    emit
  });
  if (installedVersion !== CODEX_CLI_VERSION) {
    throw new Error(`Managed Codex install is ${installedVersion || "unknown"} after installation; expected ${CODEX_CLI_VERSION}.`);
  }
}

async function installManagedCodexCli({ apiKey, paths, nodeRuntime, runtime, emit }) {
  const bundledInstaller = runtime.installBundledCodexCli || installBundledCodexCli;
  const installedFromBundle = await bundledInstaller({
    paths,
    platform: runtime.platform,
    arch: runtime.arch,
    resourcesPath: runtime.resourcesPath,
    appRoot: runtime.appRoot,
    emit
  });
  if (installedFromBundle) {
    paths.codexBinaryPath = managedCodexBinary(paths, runtime.platform);
    return;
  }

  if (runtime.packaged) {
    throw new Error("This packaged TritonAI Installer is missing a valid bundled Codex CLI payload; npm fallback is disabled for packaged builds.");
  }

  await runCommands(getCommands(CODEX_CLI, "install", runtime.platform), {
    emit,
    env: buildEnv(apiKey, paths, nodeRuntime, runtime.platform),
    paths,
    nodeRuntime,
    commandRunner: runtime.commandRunner
  });
  paths.codexBinaryPath = managedCodexBinary(paths, runtime.platform);
}

async function getCodexVersionForRuntime({ binary, env, platform, runtime, emit }) {
  if (runtime.getCodexVersion) {
    return runtime.getCodexVersion(binary);
  }

  try {
    const output = await runCommandForOutput(binary, ["--version"], { env, platform });
    return parseCodexVersion(output);
  } catch (error) {
    emit(`Could not determine managed Codex version: ${error.message}`);
    return null;
  }
}

function parseCodexVersion(output) {
  const match = String(output || "").match(/\b(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

async function installOptionalDesktopApp({ desktopInstaller, paths, platform, arch, emit, env, resourcesPath, appRoot, packaged }) {
  try {
    return await desktopInstaller({ paths, platform, arch, emit, env, resourcesPath, appRoot, packaged });
  } catch (error) {
    if (platform === "win32") {
      throw new Error(`The CLI is installed, but the desktop app still needs attention. ${error.message}`);
    }

    throw error;
  }
}

async function runT3DefaultsPatcher({ apiKey, paths, nodeRuntime, runtime, emit }) {
  if (!fs.existsSync(paths.t3DefaultsPatcher)) {
    return;
  }

  emit("Applying TritonAI Harness defaults...");
  const commandRunner = runtime.commandRunner || runCommand;
  const command = nodeRuntime && nodeRuntime.nodeBinary ? nodeRuntime.nodeBinary : "node";
  await commandRunner(command, [paths.t3DefaultsPatcher], {
    emit,
    env: buildEnv(apiKey, paths, nodeRuntime, runtime.platform),
    allowFailure: true
  });
}

async function verifyTritonAiConnection({ apiKey, runtime, emit }) {
  emit("Checking TritonAI connection...");
  const connectionChecker = runtime.checkTritonAiConnection || checkTritonAiConnection;
  const result = await connectionChecker({
    apiKey,
    baseUrl: UCSD.baseUrl,
    timeoutMs: 10000
  });
  const externalModelsEnabled = getExternalModelsEnabled(result);
  emit(externalModelsEnabled
    ? "External model access verified."
    : "External model access unavailable; configuring on-premises DeepSeek only.");
  emit("TritonAI connection verified.");
  return { externalModelsEnabled };
}

function getExternalModelsEnabled(result) {
  if (!result || typeof result !== "object") {
    return true;
  }
  return result.externalModelsEnabled !== false;
}

function buildEnv(apiKey, paths, nodeRuntime, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  const pathEntries = [
    paths.binDir,
    paths.codexBinDir,
    paths.nodeGlobalBinDir,
    nodeRuntime && nodeRuntime.nodeBinDir,
    process.env.PATH || ""
  ].filter(Boolean);

  return {
    ...process.env,
    PATH: pathEntries.join(delimiter),
    ...getTritonAiEnvironment(paths),
    [UCSD.codexHomeEnv]: paths.codexHome,
    ...(apiKey ? {
      [UCSD.apiKeyEnv]: apiKey
    } : {}),
    ...(nodeRuntime ? buildNodeLifecycleEnv(nodeRuntime) : {})
  };
}

function buildNodeLifecycleEnv(nodeRuntime) {
  return {
    NODE: nodeRuntime.nodeBinary,
    npm_node_execpath: nodeRuntime.nodeBinary,
    NPM_NODE_EXECPATH: nodeRuntime.nodeBinary,
    ...(nodeRuntime.npmCliJs ? {
      npm_execpath: nodeRuntime.npmCliJs,
      NPM_EXECPATH: nodeRuntime.npmCliJs
    } : {}),
    npm_config_scripts_prepend_node_path: "true",
    NPM_CONFIG_SCRIPTS_PREPEND_NODE_PATH: "true"
  };
}

async function runCommands(commands, options) {
  for (const [command, args] of commands) {
    const commandRunner = options.commandRunner || runCommand;
    const resolved = resolveCommand(command, resolveArgs(args, options), options);
    await commandRunner(resolved.command, resolved.args, options);
  }
}

function resolveCommand(command, args, options) {
  const resolvedCommand = resolveCommandToken(command, options);
  const { nodeRuntime } = options;
  if (resolvedCommand === "npm" && nodeRuntime) {
    if (nodeRuntime.npmCliJs) {
      return {
        command: nodeRuntime.nodeBinary,
        args: [nodeRuntime.npmCliJs, ...args]
      };
    }

    return {
      command: nodeRuntime.npmBinary,
      args
    };
  }

  return { command: resolvedCommand, args };
}

function resolveArgs(args, { paths }) {
  return args.map((arg) => {
    if (arg === "{{nodeGlobalRoot}}") return paths.nodeGlobalRoot;
    if (arg === "{{codexInstallRoot}}") return paths.codexInstallRoot;
    if (arg === "{{codexBinary}}") return paths.codexBinaryPath || managedCodexBinary(paths, paths.platform);
    return arg;
  });
}

function resolveCommandToken(command, { paths }) {
  if (command === "{{codexBinary}}") return paths.codexBinaryPath || managedCodexBinary(paths, paths.platform);
  return command;
}

function runCommand(command, args, { emit, env, allowFailure = false }) {
  return new Promise<void>((resolve, reject) => {
    emit(`$ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      env,
      shell: process.platform === "win32"
    });

    child.stdout.on("data", (chunk) => emit(clean(chunk)));
    child.stderr.on("data", (chunk) => emit(clean(chunk)));
    child.on("error", (error) => {
      if (allowFailure) {
        emit(`Verification skipped or failed: ${error.message}`);
        resolve();
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        if (code !== 0) emit(`Command exited with ${code}; continuing because this was a verification step.`);
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function runCommandForOutput(command, args, { env, platform = process.platform }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: platform === "win32"
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(`${stdout}\n${stderr}`);
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function clean(chunk) {
  return chunk.toString("utf8").replace(/\n+$/g, "");
}

function managedCodexBinary(paths, platform = process.platform) {
  return path.join(paths.codexBinDir, platform === "win32" ? "codex.cmd" : "codex");
}

function isExecutable(file, platform = process.platform) {
  if (!fs.existsSync(file)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { runInstall, buildEnv, parseCodexVersion };
