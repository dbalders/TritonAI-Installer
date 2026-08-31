const NPM_POLICY = {
  cutoffDate: "2026-08-30T00:00:00.000Z"
};

const CODEX_CLI_VERSION = "0.151.0";

function guardedNpmInstall(packageSpec, paths) {
  return [
    "install",
    "-g",
    "--prefix",
    paths ? (paths.codexInstallRoot || paths.nodeGlobalRoot) : "{{codexInstallRoot}}",
    "--before",
    NPM_POLICY.cutoffDate,
    packageSpec
  ];
}

module.exports = { NPM_POLICY, CODEX_CLI_VERSION, guardedNpmInstall };
