const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");
const mutableProcess = process as unknown as { resourcesPath?: string };
const root = path.resolve(__dirname, "..", "..");

const EXPECTED_MANAGED_BASE_URL = "https://example.invalid/v1";
delete process.env.UCSD_MANAGED_CONFIG_PATH;
delete process.env.UCSD_AI_BASE_URL;
delete process.env.UCSD_AI_DOCS_URL;
delete process.env.UCSD_ALLOW_MANAGED_CONFIG_ENV;
delete process.env.UCSD_CODEX_MODEL;
delete process.env.UCSD_RESTRICTED_CODEX_MODEL;

const { runInstall } = require("../src/installer/runner");
const { getPaths } = require("../src/installer/paths");
const { getNodeRuntimePaths } = require("../src/installer/prerequisites");
const { NPM_POLICY, CODEX_CLI_VERSION } = require("../src/installer/npm-policy");
const {
  writeT3CodeSettings
} = require("../src/installer/config-writers");
const {
  parseLatestYml,
  selectMacDmg,
  selectWindowsInstaller,
  macInfoPlist,
  getMacAppIconSource,
  buildMacLauncherScript,
  buildWindowsEnvironmentScript,
  buildWindowsDesktopShortcutScript,
  getBundledMacDmg,
  getBundledWindowsInstaller,
  findWindowsT3CodeApp,
  getManagedMacAppPath
} = require("../src/installer/t3code-desktop");
const { saveEnvironment } = require("../src/installer/profile");
const { buildWindowsEnvironmentCleanupScript } = require("../src/installer/windows-environment-migration");
const {
  getTritonAiEnvironment,
  getCodexProviderEnvironmentVariables
} = require("../src/installer/codex-environment");
const {
  findExistingApiKey,
  readApiKeyFromEnvText
} = require("../src/installer/existing-api-key");
const {
  modelsUrlForBase,
  chatCompletionsUrlForBase
} = require("../src/installer/tritonai-connection");
const {
  redactSensitive
} = require("../src/installer/diagnostics");
const {
  writeInstallerVersionMarker
} = require("../src/installer/installer-version-marker");
const { version: packageInstallerVersion } = require(path.join(root, "package.json"));
const { UCSD, resetManagedConfigForTests } = require("../src/installer/constants");

function simulateWindowsAcl(file, action, content) {
  if (action === "create") fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
}
const {
  findSkillsSourceDir,
  stageSkillsFromSource
} = require("./prepare-skills-vendor");
const {
  findBundledSkillsDir
} = require("../src/installer/skills");
const {
  findBundledCodexDir
} = require("../src/installer/codex-vendor");
const {
  normalizeNpmGlobalLayout
} = require("./prepare-codex-cli-vendor");

const EXPECTED_CODEX_MODELS = Object.keys(UCSD.codexModels);
const EXPECTED_RESTRICTED_CODEX_MODELS = [
  UCSD.restrictedCodexModel,
  "api-glm-5.2",
  "api-gemma-4-31b"
];

function expectedCodexModelMetadata(modelSlugs) {
  return Object.fromEntries(
    modelSlugs.map((slug) => {
      const model = UCSD.codexModels[slug];
      return [
        slug,
        {
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {})
        }
      ];
    })
  );
}

function assertIncludesPath(content, expectedPath) {
  const rawExpectedPath = String(expectedPath);
  const normalizedExpectedPath = rawExpectedPath.replace(/\\/g, "/");
  const jsonEscapedExpectedPath = JSON.stringify(rawExpectedPath).slice(1, -1);
  const pathVariants = [
    rawExpectedPath,
    normalizedExpectedPath,
    jsonEscapedExpectedPath,
    JSON.stringify(rawExpectedPath)
  ];
  assert(
    pathVariants.some((variant) => content.includes(variant)),
    `Expected content to include ${rawExpectedPath}`
  );
}

async function main() {
  assertManagedConfigPrefersPackagedEndpoint();
  assertManagedModelDefaultsUseApiDeepSeek();
  await assertExistingApiKeyLookup();
  assertOnboardingWorkspaceUsesHomeRoot();
  assertSkillsVendorStaging();
  assertPackagedResourceLookupFallsBackFromUndefined();
  assertCodexResourceLookupFallsBackFromUndefined();
  assertCodexVendorLayoutNormalization();
  await assertEnvironmentIsHarnessScoped();
  assertDesktopArtifactHelpers();
  assertWindowsT3CodeAppDetection();
  assertWindowsShortcutTargetsApp();
  assertT3CodeUcsdCustomModelsAreCanonical();
  assertT3DefaultsPatcherClearsRuntimeState();
  assertT3DefaultsPatcherRespectsModelAccess();
  assertDiagnosticsRedaction();
  await assertRunInstallRequiresApiKey();
  await assertRunInstallStopsBeforeDesktopWhenConnectionFails();
  assertTritonAiModelsUrl();
  await assertOnboardingWorkspaceOnlySeedsOnFirstInstall();
  await runDryRun(process.platform, {});
  await runDryRun(process.platform, {
    externalModelsEnabled: false
  });
  await runDryRun(process.platform, {
    connectionResult: { ok: true }
  });
  await runDryRun(process.platform, {
    connectionResult: { ok: true, externalModelsEnabled: "true" }
  });
  await assertExternalDefaultRespectsCapabilityProbe();
  await runDryRun(process.platform, {
    managedCodexVersion: "0.140.0",
    expectBundledCodexInstall: true
  });
  await runDryRun(process.platform, {
    managedCodexVersion: CODEX_CLI_VERSION,
    expectBundledCodexInstall: false
  });
  await runDryRun(process.platform, {
    managedCodexVersion: "0.140.0",
    bundledCodexAvailable: false,
    expectBundledCodexInstall: false
  });
  if (process.platform !== "win32") {
    await runDryRun("win32", {});
    await runDryRun("win32", {
      managedCodexVersion: "0.140.0",
      expectBundledCodexInstall: true
    });
    await runDryRun("win32", {
      managedCodexVersion: "0.140.0",
      bundledCodexAvailable: false,
      expectBundledCodexInstall: false
    });
  }
  console.log("Clean install dry run passed.");
}

async function assertEnvironmentIsHarnessScoped() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-environment-"));
  const originalPath = process.env.PATH;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalTritonAiHome = process.env.TRITONAI_HOME;

  try {
    const zshrc = path.join(tempRoot, ".zshrc");
    const bashrc = path.join(tempRoot, ".bashrc");
    fs.writeFileSync(zshrc, `# user zsh config
# TritonAI environment
[ -f "${getPaths(tempRoot, "darwin").envFile}" ] && source "${getPaths(tempRoot, "darwin").envFile}"
`);
    fs.writeFileSync(bashrc, "# user bash config\n");

    const macPaths = getPaths(tempRoot, "darwin");
    const macRuntime = getNodeRuntimePaths(macPaths, "darwin", process.arch);
    await saveEnvironment({ apiKey: "private-key", paths: macPaths, platform: "darwin", nodeRuntime: macRuntime, emit: () => {} });

    const macEnvironment = fs.readFileSync(macPaths.envFile, "utf8");
    assert(macEnvironment.includes("TRITONAI_API_KEY"));
    assert(macEnvironment.includes(macPaths.codexBinDir));
    assert(!macEnvironment.includes("CODEX_HOME"), "macOS private environment must not export CODEX_HOME");
    assert.strictEqual(fs.readFileSync(zshrc, "utf8"), "# user zsh config\n");
    assert.strictEqual(fs.readFileSync(bashrc, "utf8"), "# user bash config\n");

    const macLauncher = buildMacLauncherScript(macPaths, macRuntime.nodeBinary, getManagedMacAppPath(macPaths));
    assert(macLauncher.includes(macPaths.envFile));
    assert(!macLauncher.includes("CODEX_HOME"), "macOS launcher must leave Codex home selection to Harness child processes");

    const winPaths = getPaths(tempRoot, "win32");
    const winRuntime = getNodeRuntimePaths(winPaths, "win32", "x64");
    await saveEnvironment({ apiKey: "private-key", paths: winPaths, platform: "win32", nodeRuntime: winRuntime, emit: () => {} });

    const windowsEnvironment = fs.readFileSync(winPaths.envFile, "utf8");
    assert(windowsEnvironment.includes("TRITONAI_API_KEY"));
    assert(windowsEnvironment.includes(winPaths.codexBinDir));
    assert(!windowsEnvironment.includes("CODEX_HOME"), "Windows private environment must not export CODEX_HOME");

    const previousTestValue = ["previous", "test", "value"].join("-");
    const cleanupScript = buildWindowsEnvironmentCleanupScript({
      environmentVariables: [
        { name: "TRITONAI_API_KEY", value: previousTestValue },
        { name: "CODEX_HOME", value: winPaths.codexHome }
      ],
      pathEntries: [winPaths.binDir]
    });
    assert(cleanupScript.includes("$current -ceq $item.Value"), "Windows cleanup must remove only exact Installer-owned values");
    assert(cleanupScript.includes("$exactMatches.Count -eq 1 -and $semanticMatches.Count -eq 1"), "Windows cleanup must preserve ambiguous PATH entries");
    assert(cleanupScript.includes(winPaths.codexHome));
    assert(cleanupScript.includes(previousTestValue), "Windows cleanup must remove the API key recorded by the prior Installer");

    const windowsLauncher = buildWindowsEnvironmentScript(winPaths);
    assert(windowsLauncher.includes(winPaths.envFile));
    assert(!windowsLauncher.includes("CODEX_HOME"), "Windows launcher must leave Codex home selection to Harness child processes");

    assert.strictEqual(process.env.PATH, originalPath, "saving private environment must not mutate process PATH");
    assert.strictEqual(process.env.CODEX_HOME, originalCodexHome, "saving private environment must not mutate process CODEX_HOME");
    assert.strictEqual(process.env.TRITONAI_HOME, originalTritonAiHome, "saving private environment must not mutate process TRITONAI_HOME");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertManagedModelDefaultsUseApiDeepSeek() {
  resetManagedConfigForTests();
  assert.strictEqual(UCSD.codexModel, "api-deepseek-v4-flash");
  assert.strictEqual(UCSD.restrictedCodexModel, "api-deepseek-v4-flash");
  assert.strictEqual(UCSD.codexModels[UCSD.codexModel].name, "DeepSeek v4 Flash");
  assert.strictEqual(UCSD.codexModels[UCSD.codexModel].shortName, "DeepSeek");
  assert.strictEqual(UCSD.codexModels["api-glm-5.2"].name, "GLM 5.2");
  assert.strictEqual(UCSD.codexModels["api-glm-5.2"].shortName, "GLM");
  assert.strictEqual(UCSD.codexModels["api-glm-5.2"].availableToRestrictedKeys, true);
  assert.deepStrictEqual(UCSD.codexModels[UCSD.codexModel].capabilities.inputModalities, ["text"]);
  assert.deepStrictEqual(UCSD.codexModels["api-glm-5.2"].capabilities.inputModalities, ["text"]);
  assert.strictEqual(UCSD.codexModels["api-gemma-4-31b"].name, "Gemma 4 31B");
  assert.strictEqual(UCSD.codexModels["api-gemma-4-31b"].shortName, "Gemma");
  assert.strictEqual(UCSD.codexModels["api-gemma-4-31b"].availableToRestrictedKeys, true);
  assert.deepStrictEqual(UCSD.codexModels["api-gemma-4-31b"].capabilities.inputModalities, [
    "text",
    "image"
  ]);
  assert.strictEqual(UCSD.codexModels["gpt-5.5"].name, "GPT-5.5");
  assert.strictEqual(UCSD.codexModels["claude-opus-4-8"].name, "Claude Opus 4.8");
  assert(!UCSD.codexModel.includes("max"), "managed default should not use the Max model");
}

function assertManagedConfigPrefersPackagedEndpoint() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-managed-config-"));
  const configPath = path.join(tempRoot, "managed-config.json");
  const originalResourcesPath = mutableProcess.resourcesPath;
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: "https://packaged.example.invalid/v1",
      apiDocsUrl: "https://packaged.example.invalid/docs"
    }));

    mutableProcess.resourcesPath = tempRoot;
    process.env.UCSD_MANAGED_CONFIG_PATH = path.join(tempRoot, "ambient-managed-config.json");
    fs.writeFileSync(process.env.UCSD_MANAGED_CONFIG_PATH, JSON.stringify({
      baseUrl: "https://ambient-path.example.invalid/v1",
      apiDocsUrl: "https://ambient-path.example.invalid/docs"
    }));
    process.env.UCSD_AI_BASE_URL = "https://ambient.example.invalid/v1";
    process.env.UCSD_AI_DOCS_URL = "https://ambient.example.invalid/docs";
    delete process.env.UCSD_ALLOW_MANAGED_CONFIG_ENV;
    resetManagedConfigForTests();
    assert.strictEqual(UCSD.baseUrl, "https://packaged.example.invalid/v1");
    assert.strictEqual(UCSD.apiDocsUrl, "https://packaged.example.invalid/docs");

    process.env.UCSD_ALLOW_MANAGED_CONFIG_ENV = "1";
    resetManagedConfigForTests();
    assert.strictEqual(UCSD.baseUrl, "https://ambient.example.invalid/v1");
    assert.strictEqual(UCSD.apiDocsUrl, "https://ambient.example.invalid/docs");

    delete process.env.UCSD_ALLOW_MANAGED_CONFIG_ENV;
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: "https://packaged.example.invalid/v1",
      codexModels: {
        "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" }
      }
    }));
    resetManagedConfigForTests();
    assert.throws(
      () => UCSD.codexModels,
      /codexModels must include the configured default model: api-deepseek-v4-flash/
    );

    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: "https://packaged.example.invalid/v1",
      codexModel: "gpt-5.5",
      restrictedCodexModel: "api-deepseek-v4-flash",
      codexModels: {
        "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" }
      }
    }));
    resetManagedConfigForTests();
    assert.throws(
      () => UCSD.codexModels,
      /codexModels must include the configured restricted fallback model: api-deepseek-v4-flash/
    );

    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: "https://packaged.example.invalid/v1",
      codexModel: "gpt-5.5"
    }));
    resetManagedConfigForTests();
    assert.strictEqual(UCSD.codexModel, "gpt-5.5");
    assert.strictEqual(
      UCSD.codexModels["gpt-5.5"].name,
      "GPT-5.5",
      "a packaged default that is already in the catalog must retain its display name"
    );
  } finally {
    if (originalResourcesPath === undefined) {
      delete mutableProcess.resourcesPath;
    } else {
      mutableProcess.resourcesPath = originalResourcesPath;
    }
    delete process.env.UCSD_MANAGED_CONFIG_PATH;
    delete process.env.UCSD_AI_BASE_URL;
    delete process.env.UCSD_AI_DOCS_URL;
    delete process.env.UCSD_ALLOW_MANAGED_CONFIG_ENV;
    delete process.env.UCSD_CODEX_MODEL;
    delete process.env.UCSD_RESTRICTED_CODEX_MODEL;
    resetManagedConfigForTests();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertExternalDefaultRespectsCapabilityProbe() {
  const originalAllowEnvConfig = process.env.UCSD_ALLOW_MANAGED_CONFIG_ENV;
  const originalCodexModel = process.env.UCSD_CODEX_MODEL;
  const originalRestrictedCodexModel = process.env.UCSD_RESTRICTED_CODEX_MODEL;

  process.env.UCSD_ALLOW_MANAGED_CONFIG_ENV = "1";
  process.env.UCSD_CODEX_MODEL = "gpt-5.5";
  process.env.UCSD_RESTRICTED_CODEX_MODEL = "api-deepseek-v4-flash";
  resetManagedConfigForTests();

  try {
    await runDryRun(process.platform, {
      connectionResult: { ok: true, externalModelsEnabled: true }
    });
    await runDryRun(process.platform, {
      connectionResult: { ok: true, externalModelsEnabled: false }
    });
    assertT3DefaultsPatcherRespectsModelAccess();
  } finally {
    restoreEnvironmentVariable("UCSD_ALLOW_MANAGED_CONFIG_ENV", originalAllowEnvConfig);
    restoreEnvironmentVariable("UCSD_CODEX_MODEL", originalCodexModel);
    restoreEnvironmentVariable("UCSD_RESTRICTED_CODEX_MODEL", originalRestrictedCodexModel);
    resetManagedConfigForTests();
  }
}

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function assertOnboardingWorkspaceUsesHomeRoot() {
  const homeDir = path.join(path.sep, "Users", "tester");
  const paths = getPaths(homeDir, "darwin");
  assert.strictEqual(paths.onboardingWorkspaceDir, path.join(homeDir, "TritonAI"));
}

async function assertExistingApiKeyLookup() {
  assert.strictEqual(
    readApiKeyFromEnvText("export TRITONAI_API_KEY='old-key'"),
    "old-key"
  );
  assert.strictEqual(
    readApiKeyFromEnvText("export TRITONAI_API_KEY='quote'\\''key'"),
    "quote'key"
  );
  assert.strictEqual(
    readApiKeyFromEnvText('$env:TRITONAI_API_KEY = "windows-key"'),
    "windows-key"
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-existing-key-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
    fs.writeFileSync(paths.envFile, "export TRITONAI_API_KEY='file-key'\n");

    assert.deepStrictEqual(
      await findExistingApiKey({
        homeDir: tempRoot,
        platform: "darwin",
        env: {}
      }),
      { apiKey: "file-key", source: "installerEnvFile" }
    );

    assert.deepStrictEqual(
      await findExistingApiKey({
        homeDir: tempRoot,
        platform: "darwin",
        env: { TRITONAI_API_KEY: " env-key " }
      }),
      { apiKey: "env-key", source: "processEnvironment" }
    );

    const winPaths = getPaths(tempRoot, "win32");
    fs.writeFileSync(winPaths.envFile, '$env:TRITONAI_API_KEY = "win-key"\n');
    assert.deepStrictEqual(
      await findExistingApiKey({
        homeDir: tempRoot,
        platform: "win32",
        env: {},
        windowsEnvReader: async (_name, scope) => scope === "User" ? "user-key" : ""
      }),
      { apiKey: "user-key", source: "windowsUserEnvironment" }
    );
    assert.deepStrictEqual(
      await findExistingApiKey({
        homeDir: tempRoot,
        platform: "win32",
        env: {},
        windowsEnvReader: async (_name, scope) => scope === "Machine" ? "machine-key" : ""
      }),
      { apiKey: "machine-key", source: "windowsMachineEnvironment" }
    );
    assert.deepStrictEqual(
      await findExistingApiKey({
        homeDir: tempRoot,
        platform: "win32",
        env: {},
        windowsEnvReader: async () => ""
      }),
      { apiKey: "win-key", source: "installerEnvFile" }
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertRunInstallRequiresApiKey() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-missing-key-"));
  try {
    await assert.rejects(
      () => runInstall({ apiKey: "   " }, {
        homeDir: tempRoot,
        platform: "darwin",
        arch: process.arch,
        emit: () => {}
      }),
      (error) => {
        assert.match(error.message, /TritonAI access key is required/);
        assert(error.diagnostics, "missing-key error should include diagnostics paths");
        assertFile(error.diagnostics.logFile);
        assertFile(error.diagnostics.supportReportFile);
        const report = JSON.parse(fs.readFileSync(error.diagnostics.supportReportFile, "utf8"));
        assert.strictEqual(report.ok, false);
        assert.strictEqual(report.failedStep, "connect");
        return true;
      }
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertRunInstallStopsBeforeDesktopWhenConnectionFails() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-connection-fail-"));
  const paths = getPaths(tempRoot, "darwin");
  const runtimeArch = process.arch;
  const fakeRuntime = getNodeRuntimePaths(paths, "darwin", runtimeArch);
  let environmentSaveAttempted = false;
  let desktopInstallAttempted = false;
  let markerWriteAttempted = false;

  try {
    fs.mkdirSync(fakeRuntime.nodeBinDir, { recursive: true });
    fs.writeFileSync(fakeRuntime.nodeBinary, "");
    fs.writeFileSync(fakeRuntime.npmBinary, "");
    fs.mkdirSync(path.dirname(fakeRuntime.npmCliJs), { recursive: true });
    fs.writeFileSync(fakeRuntime.npmCliJs, "");

    let failedError = null;
    try {
      await runInstall({ apiKey: "test-key" }, {
        homeDir: tempRoot,
        platform: "darwin",
        arch: runtimeArch,
        emit: () => {},
        ensurePrerequisites: async () => fakeRuntime,
        appRoot: tempRoot,
        resourcesPath: null,
        saveEnvironment: async (environmentOptions) => {
          environmentSaveAttempted = true;
          fs.mkdirSync(path.dirname(environmentOptions.paths.envFile), { recursive: true });
          fs.writeFileSync(environmentOptions.paths.envFile, "darwin env\n");
        },
        installBundledSkills: () => {},
        getCodexVersion: () => CODEX_CLI_VERSION,
        writeManagedCodexLauncher: () => {},
        commandRunner: async () => {},
        checkTritonAiConnection: async () => {
          throw new Error("TritonAI rejected the access key. Confirm the key is active, then try again.");
        },
        installT3CodeDesktop: async () => {
          desktopInstallAttempted = true;
        },
        writeInstallerVersionMarker: () => {
          markerWriteAttempted = true;
        }
      });
    } catch (error) {
      failedError = error;
    }
    assert(failedError, "failed TritonAI connection should reject");
    assert.match(failedError.message, /TritonAI rejected the access key/);
    assert(failedError.diagnostics, "failed connection should include diagnostics paths");
    assertFile(failedError.diagnostics.logFile);
    assertFile(failedError.diagnostics.supportReportFile);
    const report = JSON.parse(fs.readFileSync(failedError.diagnostics.supportReportFile, "utf8"));
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.failedStep, "connect");
    assert(!JSON.stringify(report).includes("test-key"), "support report should redact the access key");
    assert.strictEqual(environmentSaveAttempted, false, "access key should not be saved after a failed TritonAI connection check");
    assert.strictEqual(desktopInstallAttempted, false, "desktop app should not install after a failed TritonAI connection check");
    assert.strictEqual(markerWriteAttempted, false, "failed installs must not write an installer version marker");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertTritonAiModelsUrl() {
  assert.strictEqual(
    modelsUrlForBase(EXPECTED_MANAGED_BASE_URL).toString(),
    `${EXPECTED_MANAGED_BASE_URL}/models`
  );
  assert.strictEqual(
    modelsUrlForBase(`${EXPECTED_MANAGED_BASE_URL}/`).toString(),
    `${EXPECTED_MANAGED_BASE_URL}/models`
  );
  assert.strictEqual(
    chatCompletionsUrlForBase(`${EXPECTED_MANAGED_BASE_URL}/`).toString(),
    `${EXPECTED_MANAGED_BASE_URL}/chat/completions`
  );
}

function assertSkillsVendorStaging() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-skills-vendor-"));
  try {
    const sourceRoot = path.join(tempRoot, "UCSD-Skills-Library-Secure");
    const vendorDir = path.join(tempRoot, "vendor", "skills");
    writeSkill(path.join(sourceRoot, "secure-review"), "secure-review");
    writeSkill(path.join(sourceRoot, "ucsd-dsmlp-deploy"), "ucsd-dsmlp-deploy");
    fs.mkdirSync(path.join(sourceRoot, "docs"), { recursive: true });

    const result = stageSkillsFromSource({
      sourceRoot,
      vendorDir,
      sourceInfo: { type: "local", path: sourceRoot }
    });

    assert.deepStrictEqual(result.skills, [
      "secure-review",
      "ucsd-dsmlp-deploy"
    ]);
    assertFile(path.join(vendorDir, "secure-review", "SKILL.md"));
    assertFile(path.join(vendorDir, "ucsd-dsmlp-deploy", "SKILL.md"));
    assert(!fs.existsSync(path.join(vendorDir, "docs")), "non-skill support folders should not be packaged");

    const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"));
    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.kind, "tritonai-secure");
    assert.deepStrictEqual(manifest.skills, result.skills);
    assert.strictEqual(manifest.source.type, "local");

    const overrideSourceRoot = path.join(tempRoot, "override-source");
    const overrideRoot = path.join(overrideSourceRoot, "fixtures");
    const overrideVendorDir = path.join(tempRoot, "vendor", "override-skills");
    writeSkill(path.join(overrideRoot, "secure-override"), "secure-override");
    assert.strictEqual(findSkillsSourceDir(overrideSourceRoot, "fixtures"), overrideRoot);
    const overrideResult = stageSkillsFromSource({
      sourceRoot: overrideSourceRoot,
      sourceSubdir: "fixtures",
      vendorDir: overrideVendorDir,
      sourceInfo: { type: "local", path: overrideSourceRoot }
    });
    assert.deepStrictEqual(overrideResult.skills, ["secure-override"]);
    assertFile(path.join(overrideVendorDir, "secure-override", "SKILL.md"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function writeSkill(skillDir, name) {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill.\n---\n`);
}

function assertPackagedResourceLookupFallsBackFromUndefined() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-packaged-resources-"));
  const originalResourcesPath = mutableProcess.resourcesPath;
  try {
    const resourcesPath = path.join(tempRoot, "Contents", "Resources");
    const skillsVendorDir = path.join(resourcesPath, "vendor", "skills", "tritonai-feedback");
    fs.mkdirSync(skillsVendorDir, { recursive: true });
    fs.writeFileSync(path.join(skillsVendorDir, "SKILL.md"), "---\nname: tritonai-feedback\n---\n");

    mutableProcess.resourcesPath = resourcesPath;
    assert.strictEqual(
      findBundledSkillsDir({
        resourcesPath: undefined,
        appRoot: path.join(tempRoot, "missing-app-root")
      }),
      path.join(resourcesPath, "vendor", "skills")
    );
  } finally {
    if (originalResourcesPath === undefined) {
      delete mutableProcess.resourcesPath;
    } else {
      mutableProcess.resourcesPath = originalResourcesPath;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertCodexResourceLookupFallsBackFromUndefined() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-codex-resources-"));
  const originalResourcesPath = mutableProcess.resourcesPath;
  try {
    const resourcesPath = path.join(tempRoot, "Contents", "Resources");
    const codexVendorDir = path.join(resourcesPath, "vendor", "codex-cli", "mac-arm64");
    fs.mkdirSync(path.join(codexVendorDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(codexVendorDir, "bin", "codex"), "#!/usr/bin/env sh\n");
    fs.mkdirSync(path.join(codexVendorDir, "lib", "node_modules", "@openai", "codex", "bin"), { recursive: true });
    fs.mkdirSync(path.join(codexVendorDir, "lib", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-darwin-arm64"), { recursive: true });
    fs.writeFileSync(path.join(codexVendorDir, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), "");
    fs.writeFileSync(path.join(codexVendorDir, "manifest.json"), JSON.stringify({
      name: "@openai/codex",
      version: CODEX_CLI_VERSION,
      target: "mac-arm64"
    }));

    mutableProcess.resourcesPath = resourcesPath;
    assert.strictEqual(
      findBundledCodexDir({
        resourcesPath: undefined,
        appRoot: path.join(tempRoot, "missing-app-root"),
        platform: "darwin",
        arch: "arm64"
      }),
      codexVendorDir
    );
  } finally {
    if (originalResourcesPath === undefined) {
      delete mutableProcess.resourcesPath;
    } else {
      mutableProcess.resourcesPath = originalResourcesPath;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertCodexVendorLayoutNormalization() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-codex-layout-"));
  try {
    const windowsPackageRoot = path.join(tempRoot, "node_modules", "@openai", "codex");
    const windowsNativeRoot = path.join(windowsPackageRoot, "node_modules", "@openai", "codex-win32-x64");
    fs.mkdirSync(path.join(windowsPackageRoot, "bin"), { recursive: true });
    fs.mkdirSync(windowsNativeRoot, { recursive: true });
    fs.writeFileSync(path.join(windowsPackageRoot, "bin", "codex.js"), "");

    normalizeNpmGlobalLayout(tempRoot);

    assertFile(path.join(tempRoot, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"));
    assert(fs.existsSync(path.join(tempRoot, "lib", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64")));
    assert(!fs.existsSync(windowsPackageRoot), "Windows npm global package root should move under lib/node_modules");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertWindowsT3CodeAppDetection() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-t3code-detect-"));
  try {
    const harnessApp = path.join(tempRoot, "AppData", "Local", "Programs", "TritonAI Harness", "TritonAI Harness.exe");
    fs.mkdirSync(path.dirname(harnessApp), { recursive: true });
    fs.writeFileSync(harnessApp, "");
    assert.strictEqual(findWindowsT3CodeApp(tempRoot), harnessApp);

    const releaseChannelHome = path.join(tempRoot, "release-channel-home");
    const releaseChannelApp = path.join(
      releaseChannelHome,
      "AppData",
      "Local",
      "Programs",
      "TritonAI Harness (Preview)",
      "TritonAI Harness (Preview).exe"
    );
    fs.mkdirSync(path.dirname(releaseChannelApp), { recursive: true });
    fs.writeFileSync(releaseChannelApp, "");
    assert.strictEqual(
      findWindowsT3CodeApp(releaseChannelHome),
      null,
      "only the canonical TritonAI Harness executable name may satisfy installation detection"
    );

    const protectedDir = path.join(tempRoot, "Program Files", "Windows Defender Advanced Threat Protection", "Classification", "Configuration");
    fs.mkdirSync(protectedDir, { recursive: true });
    const originalReadDirSync = fs.readdirSync;
    const originalProgramFiles = process.env.ProgramFiles;
    fs.readdirSync = (target, options) => {
      if (path.resolve(target) === path.resolve(protectedDir)) {
        const error = new Error(`EPERM: operation not permitted, scandir '${target}'`) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalReadDirSync.call(fs, target, options);
    };
    process.env.ProgramFiles = path.join(tempRoot, "Program Files");
    try {
      const programFilesApp = path.join(tempRoot, "Program Files", "TritonAI Harness", "TritonAI Harness.exe");
      fs.mkdirSync(path.dirname(programFilesApp), { recursive: true });
      fs.writeFileSync(programFilesApp, "");
      assert.strictEqual(findWindowsT3CodeApp(path.join(tempRoot, "home")), programFilesApp);
    } finally {
      fs.readdirSync = originalReadDirSync;
      if (originalProgramFiles === undefined) {
        delete process.env.ProgramFiles;
      } else {
        process.env.ProgramFiles = originalProgramFiles;
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runDryRun(platform, options) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-clean-"));
  const paths = getPaths(tempRoot, platform);
  const connectionResult = Object.prototype.hasOwnProperty.call(options, "connectionResult")
    ? options.connectionResult
    : {
        ok: true,
        externalModelsEnabled: options.externalModelsEnabled !== false
      };
  const externalModelsEnabled = Boolean(
    connectionResult
      && typeof connectionResult === "object"
      && connectionResult.externalModelsEnabled === true
  );
  const expectedModel = externalModelsEnabled
    ? UCSD.codexModel
    : UCSD.restrictedCodexModel;
  const expectedCodexModels = externalModelsEnabled
    ? Object.keys(UCSD.codexModels)
    : EXPECTED_RESTRICTED_CODEX_MODELS;
  const runtimeArch = platform === "win32" ? "x64" : process.arch;
  const fakeRuntime = getNodeRuntimePaths(paths, platform, runtimeArch);
  const commands = [];
  const t3CodeDesktopInstalls = [];
  const connectionChecks = [];
  const managedCodex = path.join(paths.codexBinDir, platform === "win32" ? "codex.cmd" : "codex");
  const staleLegacyStatusCache = path.join(paths.t3Home, "caches", "legacy-provider.json");
  const staleCodexStatusCache = path.join(paths.t3Home, "caches", "codex.json");
  let managedCodexInstalled = false;
  let bundledCodexInstalls = 0;

  try {
    fs.mkdirSync(fakeRuntime.nodeBinDir, { recursive: true });
    fs.writeFileSync(fakeRuntime.nodeBinary, "");
    fs.writeFileSync(fakeRuntime.npmBinary, "");
    fs.mkdirSync(path.dirname(fakeRuntime.npmCliJs), { recursive: true });
    fs.writeFileSync(fakeRuntime.npmCliJs, "");
    if (options.managedCodexVersion) {
      const codexJs = path.join(paths.codexInstallRoot, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
      fs.mkdirSync(path.dirname(managedCodex), { recursive: true });
      fs.mkdirSync(path.dirname(codexJs), { recursive: true });
      fs.writeFileSync(managedCodex, platform === "win32" ? "@echo off\r\n" : "#!/usr/bin/env sh\n");
      fs.writeFileSync(codexJs, "");
      if (platform !== "win32") fs.chmodSync(managedCodex, 0o755);
    }
    fs.mkdirSync(path.dirname(staleLegacyStatusCache), { recursive: true });
    fs.writeFileSync(staleLegacyStatusCache, JSON.stringify({
      instanceId: "legacyProvider",
      driver: "legacyProvider",
      probe: { version: "1.4.3", status: "error" }
    }));
    fs.writeFileSync(staleCodexStatusCache, JSON.stringify({
      instanceId: "codex",
      driver: "codex",
      probe: { version: "0.1.0", status: "error" }
    }));

    const installResult = await runInstall(
      {
        apiKey: "test-key"
      },
      {
        homeDir: tempRoot,
        platform,
        arch: runtimeArch,
        windowsAclRunner: platform === "win32" ? simulateWindowsAcl : undefined,
        emit: () => {},
        ensurePrerequisites: async () => fakeRuntime,
        appRoot: tempRoot,
        resourcesPath: null,
        saveEnvironment: async (environmentOptions) => {
          fs.mkdirSync(path.dirname(environmentOptions.paths.envFile), { recursive: true });
          fs.writeFileSync(environmentOptions.paths.envFile, `${environmentOptions.platform} env\n`);
        },
        installBundledSkills: ({ paths: installPaths }) => {
          const skillDir = path.join(installPaths.skillsDir, "tritonai-feedback");
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: tritonai-feedback\n---\n");
        },
        installBundledCodexCli: ({ paths: installPaths, platform: installPlatform }) => {
          if (options.bundledCodexAvailable === false) {
            return false;
          }
          bundledCodexInstalls += 1;
          const binary = path.join(installPaths.codexBinDir, installPlatform === "win32" ? "codex.cmd" : "codex");
          const codexJs = path.join(installPaths.codexInstallRoot, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
          fs.mkdirSync(path.dirname(binary), { recursive: true });
          fs.mkdirSync(path.dirname(codexJs), { recursive: true });
          fs.writeFileSync(binary, installPlatform === "win32" ? "@echo off\r\n" : "#!/usr/bin/env sh\n");
          fs.writeFileSync(codexJs, "");
          if (installPlatform !== "win32") fs.chmodSync(binary, 0o755);
          managedCodexInstalled = true;
          return true;
        },
        checkTritonAiConnection: async (connectionOptions) => {
          connectionChecks.push(connectionOptions);
          return connectionResult;
        },
        installT3CodeDesktop: async (installOptions) => {
          assert.strictEqual(connectionChecks.length, 1, "TritonAI connection should be checked before desktop app install");
          t3CodeDesktopInstalls.push(installOptions);
          return {
            ...(installOptions.platform === "win32"
              ? {
                  appPath: path.join(tempRoot, "AppData", "Local", "Programs", "TritonAI Harness", "TritonAI Harness.exe"),
                  shortcutPath: path.join(tempRoot, "Desktop", "TritonAI Harness.lnk")
                }
              : {
                  appPath: "/Applications/TritonAI Harness.app",
                  shortcutPath: "/Applications/TritonAI Harness.app"
                })
          };
        },
        getCodexVersion: (binary) => {
          if (binary === managedCodex) {
            return managedCodexInstalled ? CODEX_CLI_VERSION : (options.managedCodexVersion || CODEX_CLI_VERSION);
          }
          return CODEX_CLI_VERSION;
        },
        commandRunner: async (command, args, commandOptions) => {
          commands.push({ command, args, env: commandOptions.env, allowFailure: commandOptions.allowFailure });
          if (isNpmCommand({ command, args }, fakeRuntime)) {
            const npmModulesRoot = platform === "win32" ? "node_modules" : path.join("lib", "node_modules");
            const npmCodexJs = path.join(paths.codexInstallRoot, npmModulesRoot, "@openai", "codex", "bin", "codex.js");
            fs.mkdirSync(path.dirname(managedCodex), { recursive: true });
            fs.mkdirSync(path.dirname(npmCodexJs), { recursive: true });
            fs.writeFileSync(managedCodex, platform === "win32" ? "@echo off\r\n" : "#!/usr/bin/env sh\n");
            fs.writeFileSync(npmCodexJs, "");
            if (platform !== "win32") fs.chmodSync(managedCodex, 0o755);
            managedCodexInstalled = true;
          }
        },
        writeInstallerVersionMarker: (markerOptions) => {
          assert.strictEqual(
            t3CodeDesktopInstalls.length,
            1,
            "installer version marker must only be written after the desktop app install succeeds"
          );
          return writeInstallerVersionMarker(markerOptions);
        }
      }
    );
    assert(installResult.diagnostics, "successful install should return diagnostics paths");
    assertFile(installResult.diagnostics.logFile);
    assertFile(installResult.diagnostics.supportReportFile);
    const supportReport = JSON.parse(fs.readFileSync(installResult.diagnostics.supportReportFile, "utf8"));
    assert.strictEqual(supportReport.ok, true);
    assert.strictEqual(supportReport.failedStep, null);
    assert.strictEqual(supportReport.paths.logsDir, paths.logsDir);
    assert.strictEqual(supportReport.paths.codexHome, paths.codexHome);
    assert(supportReport.events.length > 0, "support report should include recent installer events");
    assert(!fs.readFileSync(installResult.diagnostics.logFile, "utf8").includes("test-key"), "installer log should redact the access key");
    assert(!JSON.stringify(supportReport).includes("test-key"), "support report should redact the access key");

    assertFile(paths.sharedAgentsFile);
    assertFile(path.join(paths.skillsDir, "tritonai-feedback", "SKILL.md"));
    assert(paths.skillsDir.startsWith(paths.codexHome), "managed secure skills should install into Codex home");
    assertFile(paths.envFile);
    assertFile(paths.t3Settings);
    assertFile(paths.t3DefaultsPatcher);
    assertFile(path.join(paths.onboardingWorkspaceDir, "README.md"));
    assertFile(paths.onboardingWorkspaceMarker);
    assertFile(paths.installerVersionMarker);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(paths.installerVersionMarker, "utf8")).version,
      packageInstallerVersion
    );
    assert(!fs.existsSync(staleLegacyStatusCache), "stale legacy provider status cache should be cleared");
    assert(!fs.existsSync(staleCodexStatusCache), "stale Codex provider status cache should be cleared");

    const managedCodexLauncher = fs.readFileSync(managedCodex, "utf8");
    assert(managedCodexLauncher.includes("NODE_BIN"), "managed Codex launcher should pin managed Node");
    if (platform === "win32") {
      assert(managedCodexLauncher.includes('"%NODE_BIN%"'));
      assert(!managedCodexLauncher.includes('\r\nnode "%SCRIPT_DIR%'));
    } else {
      assert(managedCodexLauncher.includes('exec "$NODE_BIN"'));
      assert(!managedCodexLauncher.includes('\nexec node '));
    }

    const onboardingReadme = fs.readFileSync(path.join(paths.onboardingWorkspaceDir, "README.md"), "utf8");
    assert(onboardingReadme.includes("How does TritonAI Harness work, and how can it help me?"));
    assert(onboardingReadme.includes("tritonai-feedback"));
    assert(onboardingReadme.includes(paths.codexHome));

    const expectedTritonAiEnvironment = getTritonAiEnvironment(paths);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(expectedTritonAiEnvironment, "T3CODE_HOME"),
      false,
      "the legacy T3CODE_HOME runtime alias must not be emitted"
    );
    const expectedProviderEnvironmentVariables = getCodexProviderEnvironmentVariables({
      ...paths,
      tritonAiApiKey: "test-key"
    });
    const unresolvedCommands = commands.filter((entry) => {
      return String(entry.command).includes("{{")
        || entry.args.some((arg) => String(arg).includes("{{"));
    });
    assert.deepStrictEqual(unresolvedCommands, [], "installer commands should not contain unresolved placeholders");
    const codexVerifyRuns = commands.filter((entry) => {
      return entry.command === managedCodex
        && entry.args.length === 1
        && entry.args[0] === "--version";
    });
    assert.strictEqual(codexVerifyRuns.length, 1, "managed Codex verify should use the resolved binary path");

    const t3Settings = JSON.parse(fs.readFileSync(paths.t3Settings, "utf8"));
    assert.strictEqual(t3Settings.textGenerationModelSelection.instanceId, "codex");
    assert.strictEqual(t3Settings.textGenerationModelSelection.model, expectedModel);
    assert.strictEqual(t3Settings.providers.codex.enabled, true);
    assert.strictEqual(t3Settings.providers.codex.binaryPath, managedCodex);
    assert.strictEqual(t3Settings.providers.codex.homePath, paths.codexHome);
    assert.strictEqual(t3Settings.providers.claudeAgent.enabled, false);
    assert.strictEqual(t3Settings.providerInstances.codex.driver, "codex");
    assert.strictEqual(t3Settings.providerInstances.codex.enabled, true);
    assert.strictEqual(t3Settings.providerInstances.codex.config.binaryPath, managedCodex);
    assert.strictEqual(t3Settings.providerInstances.codex.config.homePath, paths.codexHome);
    assert.deepStrictEqual(t3Settings.providerInstances.codex.config.customModels, expectedCodexModels);
    assert.deepStrictEqual(t3Settings.providers.codex.customModels, expectedCodexModels);
    assert.deepStrictEqual(
      t3Settings.providerInstances.codex.config.customModelMetadata,
      expectedCodexModelMetadata(expectedCodexModels)
    );
    assert.deepStrictEqual(
      t3Settings.providers.codex.customModelMetadata,
      expectedCodexModelMetadata(expectedCodexModels)
    );
    assert.deepStrictEqual(t3Settings.providerInstances.codex.environment, expectedProviderEnvironmentVariables);

    const t3DevSettingsPath = path.join(paths.t3Home, "dev", "settings.json");
    assert(!fs.existsSync(t3DevSettingsPath), "production install must not create development settings");

    const t3DefaultsPatcher = fs.readFileSync(paths.t3DefaultsPatcher, "utf8");
    assert.match(t3DefaultsPatcher, /projection_projects/);
    assert.match(t3DefaultsPatcher, /projection_threads/);
    const escapedT3DevSettingsPath = JSON.stringify(t3DevSettingsPath).slice(1, -1);
    assert(
      !t3DefaultsPatcher.includes(escapedT3DevSettingsPath),
      "production patcher must not manage development settings"
    );
    assert(t3DefaultsPatcher.includes(expectedModel));
    assertIncludesPath(t3DefaultsPatcher, managedCodex);
    assertIncludesPath(t3DefaultsPatcher, paths.codexHome);
    assertIncludesPath(t3DefaultsPatcher, path.join(paths.t3Home, "caches"));
    assert(!t3DefaultsPatcher.includes("test-key"), "defaults patcher should not embed the access key");

    const npmInstalls = commands.filter((entry) => isNpmCommand(entry, fakeRuntime));
    const codexWasCurrent = options.managedCodexVersion === CODEX_CLI_VERSION;
    const expectedBundledCodexInstalls = codexWasCurrent || options.bundledCodexAvailable === false ? 0 : 1;
    const expectedNpmInstalls = codexWasCurrent || options.bundledCodexAvailable !== false ? 0 : 1;
    assert.strictEqual(bundledCodexInstalls, expectedBundledCodexInstalls);
    assert.strictEqual(npmInstalls.length, expectedNpmInstalls);
    assert.strictEqual(connectionChecks.length, 1);
    assert.strictEqual(connectionChecks[0].apiKey, "test-key");
    assert.strictEqual(connectionChecks[0].baseUrl, EXPECTED_MANAGED_BASE_URL);
    assert.strictEqual(t3CodeDesktopInstalls.length, 1);
    assert.strictEqual(t3CodeDesktopInstalls[0].platform, platform);
    for (const [name, value] of Object.entries(expectedTritonAiEnvironment)) {
      assert.strictEqual(t3CodeDesktopInstalls[0].env[name], value);
    }
    assert.strictEqual(t3CodeDesktopInstalls[0].env.CODEX_HOME, paths.codexHome);
    assert.strictEqual(t3CodeDesktopInstalls[0].env.TRITONAI_API_KEY, "test-key");
    const patcherRuns = commands.filter((entry) => entry.args.includes(paths.t3DefaultsPatcher));
    assert.strictEqual(patcherRuns.length, 1);
    assert.strictEqual(patcherRuns[0].command, fakeRuntime.nodeBinary);
    assert.strictEqual(patcherRuns[0].allowFailure, true);

    for (const install of npmInstalls) {
      assert(install.args.includes("--before"), `${install.args.join(" ")} missing --before`);
      assert(install.args.includes(NPM_POLICY.cutoffDate), `${install.args.join(" ")} missing cutoff`);
      assert(install.args.includes(paths.codexInstallRoot), `${install.args.join(" ")} missing Codex install prefix`);
      assert(install.args.includes(`@openai/codex@${CODEX_CLI_VERSION}`), `${install.args.join(" ")} missing pinned Codex package`);
      assert.strictEqual(install.env.NODE, fakeRuntime.nodeBinary);
      assert.strictEqual(install.env.npm_node_execpath, fakeRuntime.nodeBinary);
      assert.strictEqual(install.env.NPM_NODE_EXECPATH, fakeRuntime.nodeBinary);
      assert.strictEqual(install.env.npm_execpath, fakeRuntime.npmCliJs);
      assert.strictEqual(install.env.NPM_EXECPATH, fakeRuntime.npmCliJs);
      assert.strictEqual(install.env.npm_config_scripts_prepend_node_path, "true");
      assert.strictEqual(install.env.NPM_CONFIG_SCRIPTS_PREPEND_NODE_PATH, "true");
    }

    for (const command of commands) {
      assert(command.env.PATH.includes(paths.codexBinDir), "PATH missing versioned Codex bin");
      assert(command.env.PATH.includes(paths.nodeGlobalBinDir), "PATH missing node-global bin");
      assert(command.env.PATH.includes(fakeRuntime.nodeBinDir), "PATH missing private Node bin");
      assert(command.env.PATH.split(platform === "win32" ? ";" : ":").includes(fakeRuntime.nodeBinDir), "PATH should include private Node bin as its own entry");
      if (platform === "win32") {
        assert(command.env.PATH.includes(";"), "Windows PATH should use semicolon delimiters");
      }
      for (const [name, value] of Object.entries(expectedTritonAiEnvironment)) {
        assert.strictEqual(command.env[name], value);
      }
      assert.strictEqual(command.env.CODEX_HOME, paths.codexHome);
      assert.strictEqual(command.env.UCSD_AI_BASE_URL, EXPECTED_MANAGED_BASE_URL);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertDiagnosticsRedaction() {
  const redacted = redactSensitive(
    "Authorization: Bearer abc123 TRITONAI_API_KEY=secret apiKey: \"secret\" accessKey='secret'",
    ["secret"]
  );
  assert(!redacted.includes("abc123"), "bearer token should be redacted");
  assert(!redacted.includes("secret"), "known secret should be redacted");
  assert(redacted.includes("[redacted]"), "redacted output should mark removed secrets");
}

function assertWindowsShortcutTargetsApp() {
  const tempRoot = "C:\\Users\\Tester";
  const paths = getPaths(tempRoot, "win32");
  const appPath = "C:\\Users\\Tester\\AppData\\Local\\Programs\\TritonAI Harness\\TritonAI Harness.exe";
  const launcherPath = "C:\\Users\\Tester\\.agents\\ucsd\\bin\\tritonai-harness-launcher.ps1";
  const script = buildWindowsDesktopShortcutScript({ paths, appPath, launcherPath });

  assert(script.includes("$shortcut.TargetPath = 'powershell.exe'"));
  assert(script.includes("-ExecutionPolicy Bypass"));
  assert(script.includes("-WindowStyle Hidden"));
  assert(script.includes(launcherPath));
  assert(script.includes(`$shortcut.IconLocation = '${appPath},0'`));
}

async function assertOnboardingWorkspaceOnlySeedsOnFirstInstall() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-onboarding-"));
  const paths = getPaths(tempRoot, "darwin");
  const runtimeArch = process.arch;
  const fakeRuntime = getNodeRuntimePaths(paths, "darwin", runtimeArch);

  try {
    fs.mkdirSync(fakeRuntime.nodeBinDir, { recursive: true });
    fs.writeFileSync(fakeRuntime.nodeBinary, "");
    fs.writeFileSync(fakeRuntime.npmBinary, "");
    fs.mkdirSync(path.dirname(fakeRuntime.npmCliJs), { recursive: true });
    fs.writeFileSync(fakeRuntime.npmCliJs, "");

    const runtime = {
      homeDir: tempRoot,
      platform: "darwin",
      arch: runtimeArch,
      emit: () => {},
      ensurePrerequisites: async () => fakeRuntime,
      appRoot: tempRoot,
      resourcesPath: null,
      saveEnvironment: async (environmentOptions) => {
        fs.mkdirSync(path.dirname(environmentOptions.paths.envFile), { recursive: true });
        fs.writeFileSync(environmentOptions.paths.envFile, "darwin env\n");
      },
      installBundledSkills: ({ paths: installPaths }) => {
        const skillDir = path.join(installPaths.skillsDir, "tritonai-feedback");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: tritonai-feedback\n---\n");
      },
      checkTritonAiConnection: async () => {},
      installT3CodeDesktop: async () => ({
        appPath: "/Applications/TritonAI Harness.app",
        shortcutPath: "/Applications/TritonAI Harness.app"
      }),
      getCodexVersion: () => CODEX_CLI_VERSION,
      writeManagedCodexLauncher: () => {},
      commandRunner: async () => {}
    };

    await runInstall({ apiKey: "test-key" }, runtime);
    const readmePath = path.join(paths.onboardingWorkspaceDir, "README.md");
    assertFile(readmePath);
    assertFile(paths.onboardingWorkspaceMarker);

    fs.rmSync(readmePath, { force: true });
    await runInstall({ apiKey: "test-key" }, runtime);
    assert(!fs.existsSync(readmePath), "onboarding README should not be recreated after the first install");
    assert(fs.existsSync(paths.onboardingWorkspaceDir), "onboarding folder should remain available");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertT3DefaultsPatcherClearsRuntimeState() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-t3-runtime-"));
  try {
    const paths = getPaths(tempRoot, process.platform);
    writeT3CodeSettings(paths);
    const stateDbPath = path.join(path.dirname(paths.t3Settings), "state.sqlite");
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });

    const db = new DatabaseSync(stateDbPath);
    db.exec(`
      CREATE TABLE provider_session_runtime (
        thread_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        adapter_key TEXT NOT NULL,
        status TEXT NOT NULL,
        resume_cursor_json TEXT,
        runtime_payload_json TEXT,
        provider_instance_id TEXT
      );
      INSERT INTO provider_session_runtime (
        thread_id,
        provider_name,
        adapter_key,
        status,
        resume_cursor_json,
        runtime_payload_json,
        provider_instance_id
      ) VALUES (
        'thread-legacy',
        'legacyProvider',
        'legacyProvider',
        'running',
        '{"cursor":"old"}',
        '{"model":"ucsd/api-deepseek-v4-flash","lastError":"Legacy provider is too old"}',
        'legacyProvider'
      );
      CREATE TABLE projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        provider_name TEXT,
        provider_instance_id TEXT,
        status TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        active_turn_id TEXT,
        last_error TEXT
      );
      INSERT INTO projection_thread_sessions (
        thread_id,
        provider_name,
        provider_instance_id,
        status,
        provider_session_id,
        provider_thread_id,
        active_turn_id,
        last_error
      ) VALUES (
        'thread-legacy',
        'legacyProvider',
        'legacyProvider',
        'running',
        'old-session',
        'old-thread',
        'old-turn',
        'Legacy provider is too old'
      );
    `);
    db.close();

    const statusCachePath = path.join(paths.t3Home, "caches", "legacy-provider.json");
    fs.mkdirSync(path.dirname(statusCachePath), { recursive: true });
    fs.writeFileSync(statusCachePath, JSON.stringify({
      instanceId: "legacyProvider",
      driver: "legacyProvider",
      probe: { version: "1.4.3", status: "error" }
    }));

    execFileSync(process.execPath, [paths.t3DefaultsPatcher], { stdio: "ignore" });

    const patched = new DatabaseSync(stateDbPath);
    const runtime = patched.prepare("SELECT * FROM provider_session_runtime WHERE thread_id = ?").get("thread-legacy");
    const session = patched.prepare("SELECT * FROM projection_thread_sessions WHERE thread_id = ?").get("thread-legacy");
    patched.close();

    assert.strictEqual(runtime.status, "stopped");
    assert.strictEqual(runtime.resume_cursor_json, null);
    assert.strictEqual(runtime.provider_name, "codex");
    assert.strictEqual(runtime.adapter_key, "codex");
    assert.strictEqual(runtime.provider_instance_id, "codex");
    const runtimePayload = JSON.parse(runtime.runtime_payload_json);
    assert.strictEqual(runtimePayload.model, UCSD.restrictedCodexModel);
    assert.deepStrictEqual(runtimePayload.modelSelection, {
      instanceId: "codex",
      model: UCSD.restrictedCodexModel
    });
    assert.strictEqual(runtimePayload.lastError, null);
    assert.strictEqual(session.provider_name, "codex");
    assert.strictEqual(session.provider_instance_id, "codex");
    assert.strictEqual(session.status, "stopped");
    assert.strictEqual(session.provider_session_id, null);
    assert.strictEqual(session.provider_thread_id, null);
    assert.strictEqual(session.active_turn_id, null);
    assert.strictEqual(session.last_error, null);
    assert(!fs.existsSync(statusCachePath), "defaults patcher should clear stale legacy provider status cache");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertT3DefaultsPatcherRespectsModelAccess() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return;
  }

  for (const externalModelsEnabled of [true, false]) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-model-access-"));
    try {
      const paths = getPaths(tempRoot, process.platform);
      paths.externalModelsEnabled = externalModelsEnabled;
      writeT3CodeSettings(paths);
      const stateDbPath = path.join(path.dirname(paths.t3Settings), "state.sqlite");
      fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });

      const db = new DatabaseSync(stateDbPath);
      db.exec("CREATE TABLE projection_threads (model_selection_json TEXT)");
      db.prepare("INSERT INTO projection_threads (model_selection_json) VALUES (?)").run(
        JSON.stringify({ instanceId: "codex", model: "gpt-5.5" })
      );
      db.close();

      execFileSync(process.execPath, [paths.t3DefaultsPatcher], { stdio: "ignore" });

      const patched = new DatabaseSync(stateDbPath);
      const selection = JSON.parse(
        patched.prepare("SELECT model_selection_json FROM projection_threads").get().model_selection_json
      );
      patched.close();
      assert.deepStrictEqual(selection, {
        instanceId: "codex",
        model: externalModelsEnabled ? "gpt-5.5" : UCSD.restrictedCodexModel
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function assertT3CodeUcsdCustomModelsAreCanonical() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-t3code-config-"));
  try {
    const paths = getPaths(tempRoot, "darwin");
    paths.externalModelsEnabled = true;
    fs.mkdirSync(path.dirname(paths.t3Settings), { recursive: true });
    fs.writeFileSync(paths.t3Settings, JSON.stringify({
      providers: {
        legacyProvider: {
          customModels: [
            "ucsd/retired-model-from-provider",
            "personal/provider-model"
          ]
        }
      },
      providerInstances: {
        legacyProvider: {
          driver: "legacyProvider",
          config: {
            customModels: [
              "ucsd/retired-model-from-instance",
              "local/kept-model"
            ]
          }
        }
      }
    }, null, 2));

    writeT3CodeSettings(paths);
    const settings = JSON.parse(fs.readFileSync(paths.t3Settings, "utf8"));
    const customModels = settings.providerInstances.codex.config.customModels;

    assert.deepStrictEqual(customModels, EXPECTED_CODEX_MODELS);
    assert.deepStrictEqual(customModels, [
      "api-deepseek-v4-flash",
      "api-glm-5.2",
      "api-gemma-4-31b",
      "gpt-5.5",
      "claude-opus-4-8"
    ]);
    assert(!customModels.includes("ucsd/retired-model-from-provider"));
    assert(!customModels.includes("ucsd/retired-model-from-instance"));
    assert.deepStrictEqual(settings.providers.codex.customModels, customModels);
    assert.deepStrictEqual(
      settings.providerInstances.codex.config.customModelMetadata,
      expectedCodexModelMetadata(EXPECTED_CODEX_MODELS)
    );
    assert.deepStrictEqual(
      settings.providers.codex.customModelMetadata,
      expectedCodexModelMetadata(EXPECTED_CODEX_MODELS)
    );
    assert.strictEqual(settings.providers.legacyProvider.enabled, false);
    assert.strictEqual(settings.providerInstances.legacyProvider.enabled, false);

    paths.externalModelsEnabled = false;
    writeT3CodeSettings(paths);
    const limitedSettings = JSON.parse(fs.readFileSync(paths.t3Settings, "utf8"));
    assert.deepStrictEqual(
      limitedSettings.providerInstances.codex.config.customModels,
      EXPECTED_RESTRICTED_CODEX_MODELS
    );
    assert.deepStrictEqual(
      limitedSettings.providers.codex.customModels,
      EXPECTED_RESTRICTED_CODEX_MODELS
    );
    assert.deepStrictEqual(
      limitedSettings.providerInstances.codex.config.customModelMetadata,
      expectedCodexModelMetadata(EXPECTED_RESTRICTED_CODEX_MODELS)
    );
    assert.deepStrictEqual(
      limitedSettings.providers.codex.customModelMetadata,
      expectedCodexModelMetadata(EXPECTED_RESTRICTED_CODEX_MODELS)
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertDesktopArtifactHelpers() {
  assert.match(macInfoPlist(), /CFBundleIconFile/);
  assert.match(macInfoPlist(), /<string>icon\.icns<\/string>/);
  assert.match(macInfoPlist(), /<string>TritonAI Harness<\/string>/);
  const legacyAppName = ["TritonAI", "Code"].join(" ");
  assert(!macInfoPlist().includes(legacyAppName), "macOS launcher metadata should use the current app name");
  const ucsdRoot = path.join(path.sep, "Users", "alice", ".agents", "ucsd");
  assert.strictEqual(getManagedMacAppPath({ ucsdRoot }), path.join(ucsdRoot, "apps", "TritonAI Harness.app"));

  const iconTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-mac-icon-"));
  try {
    const appPath = path.join(iconTempRoot, "TritonAI Harness.app");
    const contentsDir = path.join(appPath, "Contents");
    const resourcesDir = path.join(contentsDir, "Resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, "triton-brand.icns"), "fake icon");
    fs.writeFileSync(path.join(contentsDir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIconFile</key>
  <string>triton-brand</string>
</dict>
</plist>
`);
    assert.strictEqual(getMacAppIconSource(appPath), path.join(resourcesDir, "triton-brand.icns"));
  } finally {
    fs.rmSync(iconTempRoot, { recursive: true, force: true });
  }

  const t3MacManifest = parseLatestYml(`version: 0.1.3
files:
  - url: TritonAI-Harness-0.1.3-arm64.dmg
    sha512: abc
    size: 123
  - url: TritonAI-Harness-0.1.3-x64.dmg
    sha512: def
    size: 456
`);
  assert.strictEqual(t3MacManifest.version, "0.1.3");
  assert.strictEqual(selectMacDmg(t3MacManifest, "arm64").fileName, "TritonAI-Harness-0.1.3-arm64.dmg");
  assert.throws(
    () => selectMacDmg(parseLatestYml(`version: 0.1.3
files:
  - url: TritonAI-Harness-Preview-0.1.3-arm64.dmg
    sha512: abc
    size: 123
`), "arm64"),
    /does not include an asset matching/,
    "macOS runtime selection must reject noncanonical Harness basenames"
  );

  const t3WinManifest = parseLatestYml(`version: 0.1.3
files:
  - url: TritonAI-Harness-0.1.3-x64.exe
    sha512: abc
    size: 123
`);
  assert.strictEqual(selectWindowsInstaller(t3WinManifest, "x64").fileName, "TritonAI-Harness-0.1.3-x64.exe");
  assert.throws(
    () => selectWindowsInstaller(parseLatestYml(`version: 0.1.3
files:
  - url: TritonAI-Harness-Preview-0.1.3-x64.exe
    sha512: abc
    size: 123
`), "x64"),
    /does not include an asset matching/,
    "Windows runtime selection must reject noncanonical Harness basenames"
  );

  const t3TempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-t3code-bundle-"));
  try {
    assert.strictEqual(getBundledMacDmg({ appRoot: t3TempRoot, resourcesPath: null, arch: "arm64" }), null);
    assert.strictEqual(getBundledWindowsInstaller({ appRoot: t3TempRoot, resourcesPath: null, arch: "x64" }), null);

    const macVendorDir = path.join(t3TempRoot, "vendor", "t3code-desktop", "mac-arm64");
    fs.mkdirSync(macVendorDir, { recursive: true });
    fs.writeFileSync(path.join(macVendorDir, "latest-mac.yml"), `version: 0.1.3
files:
  - url: TritonAI-Harness-0.1.3-arm64.dmg
    sha512: abc
    size: 8
`);
    const dmgPath = path.join(macVendorDir, "TritonAI-Harness-0.1.3-arm64.dmg");
    fs.writeFileSync(dmgPath, "fake dmg");
    assert.strictEqual(
      getBundledMacDmg({ appRoot: t3TempRoot, resourcesPath: null, arch: "arm64" }).dmgPath,
      dmgPath
    );

    const winVendorDir = path.join(t3TempRoot, "vendor", "t3code-desktop", "win-x64");
    fs.mkdirSync(winVendorDir, { recursive: true });
    fs.writeFileSync(path.join(winVendorDir, "latest.yml"), `version: 0.1.3
files:
  - url: TritonAI-Harness-0.1.3-x64.exe
    sha512: abc
    size: 8
`);
    const installerPath = path.join(winVendorDir, "TritonAI-Harness-0.1.3-x64.exe");
    fs.writeFileSync(installerPath, "fake exe");
    assert.strictEqual(
      getBundledWindowsInstaller({ appRoot: t3TempRoot, resourcesPath: null, arch: "x64" }).installerPath,
      installerPath
    );
  } finally {
    fs.rmSync(t3TempRoot, { recursive: true, force: true });
  }
}

function isNpmCommand(entry, runtime) {
  return path.basename(entry.command).startsWith("npm")
    || (entry.command === runtime.nodeBinary && entry.args[0] === runtime.npmCliJs);
}

function assertFile(file) {
  assert(fs.existsSync(file), `Expected file to exist: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
