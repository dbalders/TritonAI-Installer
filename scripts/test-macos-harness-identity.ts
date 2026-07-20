const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  EXPECTED_MAC_HARNESS_BUNDLE_ID,
  EXPECTED_MAC_HARNESS_TEAM_ID,
  MACOS_CODESIGN_PATH,
  MACOS_PLUTIL_PATH,
  MAC_HARNESS_DESIGNATED_REQUIREMENT,
  macHarnessBundleIdentifierPlistArgs,
  macHarnessCodesignVerificationArgs
} = require("../src/installer/macos-harness-identity");
const {
  verifyExpectedMacHarnessPublisher: verifyBeforeVendoring
} = require("./prepare-t3code-desktop-vendor");
const {
  verifyExpectedMacHarnessPublisher: verifyBeforeActivation
} = require("../src/installer/t3code-desktop");

async function main() {
  assertPublisherRequirementIsPinnedAndRotationSafe();
  await assertBothEnforcementBoundariesAcceptTheExpectedPublisher();
  await assertBothEnforcementBoundariesRejectAnUnexpectedPublisher();
  await assertBothEnforcementBoundariesRejectAnUnexpectedBundleIdentifier();
  assertNativeCodesignRejectsAnUnexpectedPublisher();
  console.log("macOS Harness publisher identity tests passed.");
}

function assertNativeCodesignRejectsAnUnexpectedPublisher() {
  if (process.platform !== "darwin") return;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-harness-publisher-"));
  const appPath = path.join(tempRoot, "TritonAI Harness.app");
  try {
    const macOsDir = path.join(appPath, "Contents", "MacOS");
    fs.mkdirSync(macOsDir, { recursive: true });
    fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\"><dict>",
      `<key>CFBundleIdentifier</key><string>${EXPECTED_MAC_HARNESS_BUNDLE_ID}</string>`,
      "<key>CFBundleExecutable</key><string>TritonAI Harness</string>",
      "</dict></plist>"
    ].join("\n"));
    fs.writeFileSync(path.join(macOsDir, "TritonAI Harness"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    execFileSync(MACOS_CODESIGN_PATH, ["--force", "--sign", "-", appPath]);
    execFileSync(MACOS_CODESIGN_PATH, ["--verify", "--deep", "--strict", appPath]);
    assert.throws(
      () => verifyBeforeVendoring(appPath),
      /codesign failed with exit code 3/,
      "a structurally valid app without the pinned Apple Team ID must be rejected"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertPublisherRequirementIsPinnedAndRotationSafe() {
  assert.strictEqual(EXPECTED_MAC_HARNESS_TEAM_ID, "DTZW32QN7F");
  assert.strictEqual(EXPECTED_MAC_HARNESS_BUNDLE_ID, "edu.ucsd.tritonai.harness");
  assert(MAC_HARNESS_DESIGNATED_REQUIREMENT.includes("anchor apple generic"));
  assert(MAC_HARNESS_DESIGNATED_REQUIREMENT.includes(`identifier "${EXPECTED_MAC_HARNESS_BUNDLE_ID}"`));
  assert(MAC_HARNESS_DESIGNATED_REQUIREMENT.includes(`certificate leaf[subject.OU] = "${EXPECTED_MAC_HARNESS_TEAM_ID}"`));
  assert(!/certificate\s+leaf\s*=|cdhash|sha-?\d|fingerprint/i.test(MAC_HARNESS_DESIGNATED_REQUIREMENT));

  const commands = macHarnessCodesignVerificationArgs("/fixture/TritonAI Harness.app");
  assert.deepStrictEqual(commands[0].slice(0, 4), ["--verify", "--deep", "--strict", "--verbose=2"]);
  assert(commands[1].includes("-R"), "publisher verification must use codesign's test-requirement option");
  assert(!commands[1].includes("--requirements"), "the signing-time requirements option does not enforce verification");
  assert.deepStrictEqual(
    macHarnessBundleIdentifierPlistArgs("/fixture/TritonAI Harness.app"),
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      path.join("/fixture/TritonAI Harness.app", "Contents", "Info.plist")
    ]
  );
  assert.strictEqual(MACOS_CODESIGN_PATH, "/usr/bin/codesign");
  assert.strictEqual(MACOS_PLUTIL_PATH, "/usr/bin/plutil");
}

async function assertBothEnforcementBoundariesAcceptTheExpectedPublisher() {
  const syncCalls = [];
  verifyBeforeVendoring(
    "/fixture/TritonAI Harness.app",
    (command, args) => syncCalls.push({ command, args }),
    () => EXPECTED_MAC_HARNESS_BUNDLE_ID
  );

  const asyncCalls = [];
  await verifyBeforeActivation(
    "/fixture/TritonAI Harness.app",
    () => {},
    async (command, args) => asyncCalls.push({ command, args }),
    async () => EXPECTED_MAC_HARNESS_BUNDLE_ID
  );

  assert.deepStrictEqual(syncCalls, expectedCalls());
  assert.deepStrictEqual(asyncCalls, expectedCalls());
}

async function assertBothEnforcementBoundariesRejectAnUnexpectedPublisher() {
  const rejectIdentity = (command, args) => {
    if (args.includes("-R")) {
      throw new Error(`${command} rejected unexpected Harness publisher`);
    }
  };

  assert.throws(
    () => verifyBeforeVendoring(
      "/fixture/TritonAI Harness.app",
      rejectIdentity,
      () => EXPECTED_MAC_HARNESS_BUNDLE_ID
    ),
    /rejected unexpected Harness publisher/
  );
  await assert.rejects(
    verifyBeforeActivation(
      "/fixture/TritonAI Harness.app",
      () => {},
      rejectIdentity,
      async () => EXPECTED_MAC_HARNESS_BUNDLE_ID
    ),
    /rejected unexpected Harness publisher/
  );
}

async function assertBothEnforcementBoundariesRejectAnUnexpectedBundleIdentifier() {
  let codesignCalls = 0;
  const recordCodesign = () => { codesignCalls += 1; };
  const readUnexpectedBundleIdentifier = () => "edu.ucsd.tritonai.other";

  assert.throws(
    () => verifyBeforeVendoring(
      "/fixture/TritonAI Harness.app",
      recordCodesign,
      readUnexpectedBundleIdentifier
    ),
    /bundle identifier edu\.ucsd\.tritonai\.other does not match expected edu\.ucsd\.tritonai\.harness/
  );
  await assert.rejects(
    verifyBeforeActivation(
      "/fixture/TritonAI Harness.app",
      () => {},
      recordCodesign,
      readUnexpectedBundleIdentifier
    ),
    /bundle identifier edu\.ucsd\.tritonai\.other does not match expected edu\.ucsd\.tritonai\.harness/
  );
  assert.strictEqual(codesignCalls, 0, "bundle mismatch must fail before signature acceptance");
}

function expectedCalls() {
  return macHarnessCodesignVerificationArgs("/fixture/TritonAI Harness.app")
    .map((args) => ({ command: MACOS_CODESIGN_PATH, args }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
