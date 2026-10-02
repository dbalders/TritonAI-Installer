const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { getPaths } = require("../src/installer/paths");
const { getNodeRuntimePaths } = require("../src/installer/prerequisites");
const { CODEX_CLI_VERSION } = require("../src/installer/npm-policy");
const { UCSD } = require("../src/installer/constants");
const { buildEnv, runInstall, runCommand, runCommandForOutput } = require("../src/installer/runner");
const { saveEnvironment, powerShellLiteral } = require("../src/installer/profile");
const { writeManagedCodexLauncher } = require("../src/installer/codex-vendor");
const { writeWindowsLauncherScript } = require("../src/installer/t3code-desktop");

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-profile-paths-"));
  try {
    const paths = getPaths(path.join(temporary, "José Jane & O'Brien"), "win32");
    const runtime = getNodeRuntimePaths(paths, "win32", "x64");
    fs.mkdirSync(path.dirname(runtime.nodeBinary), { recursive: true });
    if (process.platform === "win32") fs.copyFileSync(process.execPath, runtime.nodeBinary);
    else runtime.nodeBinary = process.execPath;
    const calls = path.join(temporary, "codex-calls.jsonl");
    const env = { ...buildEnv({ apiKey: "synthetic-test-key" }, paths, runtime, "win32"), TEST_CODEX_CALLS: calls };
    for (const modules of [path.join("lib", "node_modules"), "node_modules"]) {
      const entrypoint = path.join(paths.codexInstallRoot, modules, "@openai", "codex", "bin", "codex.js");
      fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
      fs.writeFileSync(entrypoint, [
        "const fs = require('fs');",
        "if (process.env.TEST_CODEX_CALLS) fs.appendFileSync(process.env.TEST_CODEX_CALLS, JSON.stringify({args: process.argv.slice(2), home: process.env.CODEX_HOME}) + '\\n');",
        `console.log('codex-cli ${CODEX_CLI_VERSION}');`,
      ].join("\n"));
      const binary = writeManagedCodexLauncher({ installRoot: paths.codexInstallRoot, nodeBinary: runtime.nodeBinary, platform: "win32" });
      const options = { env, paths, nodeRuntime: runtime, platform: "win32" };
      assert.match(await runCommandForOutput(binary, ["--version"], options), new RegExp(CODEX_CLI_VERSION.replaceAll(".", "\\.")));
      const argumentsWithShellCharacters = ["a & b", "literal%PATH%", 'a"b', "(parentheses)"];
      await runCommand(binary, argumentsWithShellCharacters, { ...options, emit: () => {} });
      const recorded = fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
      assert.deepStrictEqual(recorded.at(-1).args, argumentsWithShellCharacters);
      assert.strictEqual(recorded.at(-1).home, paths.codexHome);
      if (modules === "node_modules") fs.rmSync(path.join(paths.codexInstallRoot, modules), { recursive: true });
    }

    let reachedDesktop = false;
    await runInstall({ apiKey: "synthetic-test-key" }, {
      homeDir: paths.homeDir,
      platform: "win32",
      arch: "x64",
      emit: () => {},
      checkInstallCapacity: () => {},
      inspectBundledPluginComposition: () => null,
      ensurePrerequisites: async () => runtime,
      installBundledSkills: () => {},
      checkTritonAiConnection: async () => ({ externalModelsEnabled: true }),
      windowsAclRunner: (file, action, contents) => {
        if (action === "create") fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
      },
      installT3CodeDesktop: async () => { reachedDesktop = true; return {}; },
    });
    assert.strictEqual(reachedDesktop, true, "the real managed Codex version probe must allow installation to reach the desktop step");

    await saveEnvironment({ apiKey: "synthetic-test-key", paths, nodeRuntime: runtime, platform: "win32", emit: () => {} });
    const appPath = path.join(paths.homeDir, "Harness App", "Harness.exe");
    fs.mkdirSync(path.dirname(appPath), { recursive: true });
    fs.writeFileSync(appPath, "synthetic app");
    const launcher = writeWindowsLauncherScript({ paths, appPath, emit: () => {} });
    for (const file of [paths.envFile, launcher]) {
      assert.deepStrictEqual([...fs.readFileSync(file).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.match(fs.readFileSync(file, "utf8"), /José Jane & O'Brien|José Jane & O''Brien/);
    }
    if (process.platform === "win32") {
      const capture = path.join(temporary, "launch.json");
      const wrapper = path.join(temporary, "verify-launch.ps1");
      fs.writeFileSync(wrapper, `\uFEFF$ErrorActionPreference = 'Stop'
function Start-Process {
  param($FilePath, $WorkingDirectory)
  $result = @{ app = $FilePath; directory = $WorkingDirectory; home = $env:${UCSD.tritonAiHomeEnv}; key = $env:${UCSD.apiKeyEnv} }
  [IO.File]::WriteAllText(${powerShellLiteral(capture)}, ($result | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
}
. ${powerShellLiteral(launcher)}
`);
      const powerShell = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], { encoding: "utf8" });
      assert.strictEqual(powerShell.status, 0, powerShell.stderr);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(capture, "utf8")), {
        app: appPath,
        directory: path.dirname(appPath),
        home: paths.t3Home,
        key: "synthetic-test-key",
      });
      const binary = path.join(paths.codexBinDir, "codex.cmd");
      const cmd = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${binary}" --version"`], {
        encoding: "utf8", windowsVerbatimArguments: true, env,
      });
      assert.strictEqual(cmd.status, 0, cmd.stderr);
      assert.match(cmd.stdout, /codex-cli/);
      console.log("Native Windows cmd.exe and Windows PowerShell profile-path tests passed.");
    }
    console.log("Managed Codex and PowerShell profile-path tests passed.");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
