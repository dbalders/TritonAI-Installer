const path = require("path");

const EXPECTED_MAC_HARNESS_TEAM_ID = "DTZW32QN7F";
const EXPECTED_MAC_HARNESS_BUNDLE_ID = "edu.ucsd.tritonai.harness";
const MACOS_CODESIGN_PATH = "/usr/bin/codesign";
const MACOS_PLUTIL_PATH = "/usr/bin/plutil";
const MAC_HARNESS_DESIGNATED_REQUIREMENT = [
  "anchor apple generic",
  `identifier "${EXPECTED_MAC_HARNESS_BUNDLE_ID}"`,
  `certificate leaf[subject.OU] = "${EXPECTED_MAC_HARNESS_TEAM_ID}"`
].join(" and ");

function macHarnessCodesignVerificationArgs(appPath) {
  return [
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    [
      "--verify",
      "--strict",
      "--verbose=2",
      "-R",
      `=${MAC_HARNESS_DESIGNATED_REQUIREMENT}`,
      appPath
    ]
  ];
}

function macHarnessBundleIdentifierPlistArgs(appPath) {
  return [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist")
  ];
}

function assertExpectedMacHarnessBundleIdentifier(actualBundleIdentifier) {
  const actual = String(actualBundleIdentifier).trim();
  if (actual !== EXPECTED_MAC_HARNESS_BUNDLE_ID) {
    throw new Error(
      `TritonAI Harness bundle identifier ${actual || "missing"} does not match expected ${EXPECTED_MAC_HARNESS_BUNDLE_ID}.`
    );
  }
}

module.exports = {
  EXPECTED_MAC_HARNESS_TEAM_ID,
  EXPECTED_MAC_HARNESS_BUNDLE_ID,
  MACOS_CODESIGN_PATH,
  MACOS_PLUTIL_PATH,
  MAC_HARNESS_DESIGNATED_REQUIREMENT,
  assertExpectedMacHarnessBundleIdentifier,
  macHarnessBundleIdentifierPlistArgs,
  macHarnessCodesignVerificationArgs
};
