import { verifyPackagedCodexPolicy } from "./verify-packaged-codex-policy";
import { verifyHarnessRunArtifacts } from "./verify-harness-run-artifacts";
const crypto = require("crypto");
const { pathToFileURL } = require("node:url");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const {
  assertArtifactBinding,
  assertMatchingPluginComposition,
  validateManagedPluginBundleManifest
} = require("../src/installer/plugin-bundle-manifest");
const {
  MACOS_CODESIGN_PATH,
  MACOS_PLUTIL_PATH,
  assertExpectedMacHarnessBundleIdentifier,
  macHarnessBundleIdentifierPlistArgs,
  macHarnessCodesignVerificationArgs
} = require("../src/installer/macos-harness-identity");
const { EXPECTED_WINDOWS_PUBLISHER_NAME } = require("../src/installer/windows-publisher-identity");
const {
  WINDOWS_ARTIFACT_TRUST_FILE,
  assertWindowsArtifactTrustMode,
  createWindowsArtifactTrustPolicy
} = require("../src/installer/windows-artifact-trust");

const root = path.resolve(__dirname, "..", "..");
const {
  expectedHarnessVersion,
  defaultReleaseBase,
  macReleaseBase,
  winReleaseBase
} = readHarnessSourceEnvironment(process.env);
const macManifestFile = "latest-mac.yml";
const winManifestFile = "latest.yml";
const pluginCompositionFile = "tritonai-plugin-composition.json";

function publishedPluginCompositionFile(platform, arch) {
  if ((platform !== "mac" && platform !== "win") || !/^[a-z0-9]+$/.test(arch)) {
    throw new Error(`Unsupported Harness plugin composition target: ${platform}-${arch}.`);
  }
  return `tritonai-plugin-composition-${platform}-${arch}.json`;
}

function readHarnessSourceEnvironment(env: NodeJS.ProcessEnv = {}) {
  const expectedVersion = env.TRITONAI_HARNESS_VERSION || "";
  const source = env.HARNESS_SOURCE || "published";
  if (!["published", "workflow_artifacts"].includes(source)) throw new Error("Unknown Harness release source.");
  if (source === "workflow_artifacts" && (!env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR || !env.HARNESS_WORKFLOW_RECEIPT)) throw new Error("Workflow Harness requires authenticated run artifacts and a frozen provenance receipt.");
  const releaseBase = source === "workflow_artifacts" ? pathToFileURL(path.resolve(env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR!)).href : env.TRITONAI_HARNESS_RELEASE_BASE || "";
  return {
    expectedHarnessVersion: expectedVersion,
    defaultReleaseBase: releaseBase,
    macReleaseBase: source === "workflow_artifacts" ? releaseBase : env.TRITONAI_HARNESS_MAC_RELEASE_BASE || releaseBase,
    winReleaseBase: source === "workflow_artifacts" ? releaseBase : env.TRITONAI_HARNESS_WIN_RELEASE_BASE || releaseBase
  };
}

function main() {
  const target = process.argv[2] || process.env.TRITONAI_HARNESS_VENDOR_TARGET || defaultTarget();
  const windowsTrustMode = readWindowsTrustMode(process.argv.slice(3));
  assertExplicitHarnessSource({ expectedVersion: expectedHarnessVersion, macReleaseBase, winReleaseBase, target });
  markLocalReleaseCandidate(process.env);

  if (target === "mac-arm64") {
    prepareMacVendor("arm64");
    return;
  }

  if (target === "win-x64") {
    prepareWindowsVendor("x64", windowsTrustMode);
    return;
  }

  if (target === "all") {
    prepareAllVendors(windowsTrustMode);
    return;
  }

  throw new Error(`Unsupported TritonAI Harness vendor target: ${target}`);
}

function readWindowsTrustMode(args) {
  const optionIndex = args.indexOf("--windows-trust-mode");
  if (optionIndex === -1) return "authenticode";
  if (optionIndex !== args.length - 2) {
    throw new Error("--windows-trust-mode must be followed by exactly one mode and no unknown arguments.");
  }
  return assertWindowsArtifactTrustMode(args[optionIndex + 1]);
}

function defaultTarget() {
  return process.platform === "darwin" ? "mac-arm64" : "win-x64";
}

function prepareMacVendor(arch) {
  const stage = stageMacVendor(arch);
  try {
    activatePreparedVendors([stage]);
    console.log(`Prepared ${path.relative(root, path.join(stage.vendorDir, stage.assetName))}`);
  } finally {
    fs.rmSync(stage.stagingDir, { recursive: true, force: true });
  }
}

function stageMacVendor(arch) {
  const vendorDir = path.join(root, "vendor", "t3code-desktop", `mac-${arch}`);
  const stagingDir = createSiblingTempDir(vendorDir, ".harness-mac-vendor-");
  try {
    const manifestPath = path.join(stagingDir, macManifestFile);
    downloadManifest(`${macReleaseBase}/${macManifestFile}`, manifestPath);
    const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
    assertManifestVersion(manifest, expectedHarnessVersion, "macOS");
    const expectedName = `TritonAI-Harness-${expectedHarnessVersion}-${arch}.dmg`;
    const selected = selectManifestFile(manifest, new RegExp(`^${escapeRegExp(expectedName)}$`));
    const dmgPath = path.join(stagingDir, selected.fileName);
    downloadVerified(`${macReleaseBase}/${selected.fileName}`, dmgPath, selected.expected);
    downloadAndVerifyPluginComposition(
      macReleaseBase,
      stagingDir,
      expectedHarnessVersion,
      dmgPath,
      selected.expected,
      publishedPluginCompositionFile("mac", arch)
    );
    verifyDmgContainsApp(dmgPath);
    if (process.env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR) {
      verifyHarnessRunArtifacts(process.env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR, stagingDir, expectedHarnessVersion, "mac");
    }
    return { stagingDir, vendorDir, version: manifest.version, assetName: selected.fileName };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function prepareWindowsVendor(arch, trustMode = "authenticode") {
  const stage = stageWindowsVendor(arch, trustMode);
  try {
    activatePreparedVendors([stage]);
    console.log(`Prepared ${path.relative(root, path.join(stage.vendorDir, stage.assetName))}`);
  } finally {
    fs.rmSync(stage.stagingDir, { recursive: true, force: true });
  }
}

function stageWindowsVendor(arch, trustMode = "authenticode") {
  assertWindowsArtifactTrustMode(trustMode);
  const vendorDir = path.join(root, "vendor", "t3code-desktop", `win-${arch}`);
  const stagingDir = createSiblingTempDir(vendorDir, ".harness-win-vendor-");
  try {
    const manifestPath = path.join(stagingDir, winManifestFile);
    downloadManifest(`${winReleaseBase}/${winManifestFile}`, manifestPath);
    const manifest = parseLatestYml(fs.readFileSync(manifestPath, "utf8"));
    assertManifestVersion(manifest, expectedHarnessVersion, "Windows");
    const expectedName = `TritonAI-Harness-${expectedHarnessVersion}-${arch}.exe`;
    const selected = selectManifestFile(manifest, new RegExp(`^${escapeRegExp(expectedName)}$`));
    const installerPath = path.join(stagingDir, selected.fileName);
    downloadVerified(`${winReleaseBase}/${selected.fileName}`, installerPath, selected.expected);
    if (trustMode === "authenticode") {
      verifyExpectedWindowsHarnessPublisher(installerPath);
    }
    downloadAndVerifyPluginComposition(
      winReleaseBase,
      stagingDir,
      expectedHarnessVersion,
      installerPath,
      selected.expected,
      publishedPluginCompositionFile("win", arch)
    );
    execFileSync(process.execPath, [path.join(__dirname, "verify-packaged-codex-policy.js"), installerPath, expectedHarnessVersion], { stdio: "inherit" });
    const runArtifactDirectory = process.env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR;
    if (runArtifactDirectory) {
      const files = verifyHarnessRunArtifacts(runArtifactDirectory, stagingDir, expectedHarnessVersion);
      const proofPath = path.join(root, "artifacts", "windows-installer", "harness-run-binding.json");
      fs.mkdirSync(path.dirname(proofPath), { recursive: true });
      fs.writeFileSync(proofPath, `${JSON.stringify({
        schemaVersion: 1,
        repository: "dbalders/TritonAI-Harness",
        runId: process.env.HARNESS_RUN_ID,
        commit: process.env.HARNESS_COMMIT,
        version: expectedHarnessVersion,
        files
      }, null, 2)}\n`, "utf8");
    }
    const trustPolicy = createWindowsArtifactTrustPolicy({
      mode: trustMode,
      version: manifest.version,
      artifactPath: installerPath
    });
    fs.writeFileSync(
      path.join(stagingDir, WINDOWS_ARTIFACT_TRUST_FILE),
      `${JSON.stringify(trustPolicy, null, 2)}\n`,
      "utf8"
    );
    return { stagingDir, vendorDir, version: manifest.version, assetName: selected.fileName };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function downloadAndVerifyPluginComposition(
  releaseBase,
  stagingDir,
  harnessVersion,
  artifactPath,
  expectedArtifact,
  publishedFileName
) {
  const target = path.join(stagingDir, pluginCompositionFile);
  try {
    downloadManifest(`${releaseBase}/${publishedFileName}`, target);
  } catch (error) {
    throw new Error(
      `TritonAI Harness ${harnessVersion} does not publish the required ${publishedFileName} build-composition proof. `
      + "Harness must compose the exact pinned plugin packages before the Installer may bundle this release. "
      + error.message
    );
  }
  return verifyPluginCompositionProof({
    proofPath: target,
    harnessVersion,
    artifactPath,
    expectedArtifact
  });
}

function verifyPluginCompositionProof({
  proofPath,
  harnessVersion,
  artifactPath,
  expectedArtifact
}) {
  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  } catch (error) {
    throw new Error(`TritonAI Harness ${pluginCompositionFile} is not valid JSON: ${error.message}`);
  }
  actual = validateManagedPluginBundleManifest(actual, `TritonAI Harness ${harnessVersion} plugin composition`);
  const artifact = {
    fileName: path.basename(artifactPath),
    size: fs.statSync(artifactPath).size,
    sha512: sha512Base64(artifactPath)
  };
  if (artifact.size !== expectedArtifact.size || artifact.sha512 !== expectedArtifact.sha512) {
    throw new Error(`Downloaded ${artifact.fileName} no longer matches its Harness release manifest.`);
  }
  assertArtifactBinding(actual, artifact, `TritonAI Harness ${harnessVersion} plugin composition`);
  return actual;
}

function prepareAllVendors(windowsTrustMode = "authenticode") {
  const stages = [];
  try {
    stages.push(stageMacVendor("arm64"));
    stages.push(stageWindowsVendor("x64", windowsTrustMode));
    assertMatchingManifestVersions(stages.map((stage) => stage.version));
    activatePreparedVendors(stages);
    for (const stage of stages) {
      console.log(`Prepared ${path.relative(root, path.join(stage.vendorDir, stage.assetName))}`);
    }
  } finally {
    for (const stage of stages) {
      fs.rmSync(stage.stagingDir, { recursive: true, force: true });
    }
  }
}

function assertExplicitHarnessSource({ expectedVersion, macReleaseBase, winReleaseBase, target }) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error("TRITONAI_HARNESS_VERSION must explicitly name the stable TritonAI Harness version to vendor.");
  }
  if (["mac-arm64", "all"].includes(target) && !macReleaseBase) {
    throw new Error("Set TRITONAI_HARNESS_RELEASE_BASE or TRITONAI_HARNESS_MAC_RELEASE_BASE explicitly.");
  }
  if (["win-x64", "all"].includes(target) && !winReleaseBase) {
    throw new Error("Set TRITONAI_HARNESS_RELEASE_BASE or TRITONAI_HARNESS_WIN_RELEASE_BASE explicitly.");
  }
}

function assertManifestVersion(manifest, expectedVersion, platformLabel) {
  if (manifest.version !== expectedVersion) {
    throw new Error(`${platformLabel} TritonAI Harness manifest version ${manifest.version || "missing"} does not match expected ${expectedVersion}.`);
  }
}

function assertMatchingManifestVersions(versions) {
  const unique = [...new Set(versions.filter(Boolean))];
  if (unique.length !== 1) {
    throw new Error(`macOS and Windows TritonAI Harness manifest versions must match; found ${unique.join(", ") || "none"}.`);
  }
}

function createSiblingTempDir(target, prefix) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function activatePreparedVendors(stages, requirementPath = path.join(root, "build", "managed-plugin-composition.generated.json")) {
  if (!stages.length) throw new Error("No verified Harness vendors to activate.");
  const compositions = stages.map((stage) => validateManagedPluginBundleManifest(
    JSON.parse(fs.readFileSync(path.join(stage.stagingDir, pluginCompositionFile), "utf8")),
    "Staged Harness plugin composition"
  ));
  for (const composition of compositions.slice(1)) {
    assertMatchingPluginComposition(compositions[0], composition, "macOS and Windows Harness plugin composition");
  }
  const markerRoot = createSiblingTempDir(requirementPath, ".harness-proof-requirement-");
  const marker = path.join(markerRoot, "requirement.json");
  try {
    fs.writeFileSync(marker, `${JSON.stringify({ version: 1, required: true }, null, 2)}\n`);
    activateStagedVendors([...stages, { stagingDir: marker, vendorDir: requirementPath, requirement: true }]);
  } finally {
    fs.rmSync(markerRoot, { recursive: true, force: true });
  }
}

// This is a publication-refusal marker, not a second plugin selection authority.
// The frozen local controller validates its catalog against the Harness composition.
function markLocalReleaseCandidate(env, candidateRoot = root) {
  const flag = env.TRITONAI_LOCAL_RELEASE_CANDIDATE;
  const catalogPath = env.TRITONAI_PLUGIN_CATALOG_PATH;
  if (!flag && !catalogPath) return null;
  if (flag !== "1" || !catalogPath || !path.isAbsolute(catalogPath)) {
    throw new Error("Local release candidate requires TRITONAI_LOCAL_RELEASE_CANDIDATE=1 and an absolute TRITONAI_PLUGIN_CATALOG_PATH.");
  }
  const stat = fs.lstatSync(catalogPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Local candidate catalog must be a regular file.");
  const marker = path.join(candidateRoot, "artifacts", "local-release-candidate.json");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${JSON.stringify({
    schemaVersion: 1,
    kind: "tritonai-local-release-candidate",
    pluginCatalog: { path: catalogPath, sha256: crypto.createHash("sha256").update(fs.readFileSync(catalogPath)).digest("hex") }
  }, null, 2)}\n`);
  return marker;
}

function activateStagedVendors(stages) {
  const activated = [];
  let preserveBackups = false;
  try {
    for (const stage of stages) {
      const backupRoot = createSiblingTempDir(stage.vendorDir, ".harness-vendor-backup-");
      const previous = path.join(backupRoot, path.basename(stage.vendorDir));
      activated.push({ ...stage, backupRoot, previous, previousMoved: false, activated: false });
    }
    // Back up policy before touching any payload. A failure during an earlier
    // platform activation must retain the old marker as part of recovery too.
    const backupOrder = [...activated].sort((left, right) => Number(Boolean(right.requirement)) - Number(Boolean(left.requirement)));
    for (const record of backupOrder) {
      if (fs.existsSync(record.vendorDir)) {
        fs.renameSync(record.vendorDir, record.previous);
        record.previousMoved = true;
      }
    }
    for (const record of activated) {
      fs.renameSync(record.stagingDir, record.vendorDir);
      record.activated = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    // Quarantine the complete failed generation before restoring any prior state.
    // Removing large payloads in place could leave a partially deleted public tree.
    for (const record of [...activated].reverse()) {
      if (!record.activated) continue;
      try {
        fs.renameSync(record.vendorDir, path.join(record.backupRoot, "failed-vendor"));
        record.activated = false;
      } catch (rollbackError) {
        rollbackErrors.push(`${record.vendorDir}: ${rollbackError.message}`);
      }
    }
    if (!rollbackErrors.length) {
      // The requirement marker is last. An optional marker must never accompany
      // payloads whose rollback failed, even if a different platform restored.
      for (const record of activated) {
        if (!record.previousMoved) continue;
        try {
          fs.renameSync(record.previous, record.vendorDir);
          record.previousMoved = false;
        } catch (rollbackError) {
          rollbackErrors.push(`${record.vendorDir}: ${rollbackError.message}`);
          break;
        }
      }
    }
    if (rollbackErrors.length) {
      preserveBackups = true;
      const requirement = stages.find((stage) => stage.requirement);
      if (requirement) {
        try {
          fs.writeFileSync(requirement.vendorDir, `${JSON.stringify({ version: 1, required: true })}\n`);
        } catch (markerError) {
          rollbackErrors.push(`Could not retain required-proof marker: ${markerError.message}`);
        }
      }
      throw new Error(`${error.message} Vendor rollback failures: ${rollbackErrors.join("; ")}; recovery backups kept at ${activated.map((record) => record.backupRoot).join(", ")}`);
    }
    throw error;
  } finally {
    if (!preserveBackups) {
      for (const record of activated) fs.rmSync(record.backupRoot, { recursive: true, force: true });
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function downloadVerified(url, target, expected) {
  const valid = fs.existsSync(target)
    && fs.statSync(target).size === expected.size
    && sha512Base64(target) === expected.sha512;

  if (valid) {
    console.log(`Using cached ${path.basename(target)}`);
    return;
  }

  const temp = tempDownloadPath(target);
  fs.rmSync(temp, { force: true });
  downloadFresh(url, temp);

  if (fs.statSync(temp).size !== expected.size) {
    fs.rmSync(temp, { force: true });
    throw new Error(`Size mismatch for ${path.basename(target)}`);
  }
  if (sha512Base64(temp) !== expected.sha512) {
    fs.rmSync(temp, { force: true });
    throw new Error(`SHA-512 mismatch for ${path.basename(target)}`);
  }

  fs.renameSync(temp, target);
}

function removeMatchingFiles(dir, pattern, keep = new Set()) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (keep.has(entry)) continue;
    if (pattern.test(entry)) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

function downloadManifest(url, target) {
  const temp = tempDownloadPath(target);
  fs.rmSync(temp, { force: true });

  try {
    downloadFresh(url, temp);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function downloadFresh(url, target) {
  console.log(`Downloading ${url}...`);
  const temp = tempDownloadPath(target);
  fs.rmSync(temp, { force: true });

  execFileSync("curl", [
    "-fL",
    "--connect-timeout",
    "15",
    "--max-time",
    "600",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    url,
    "-o",
    temp
  ], { stdio: "inherit" });
  fs.renameSync(temp, target);
}

function tempDownloadPath(target) {
  // Atomic rename requires the temporary file to be on the destination volume.
  return path.join(path.dirname(target), `${path.basename(target)}.${process.pid}.tmp`);
}

function verifyDmgContainsApp(file) {
  if (process.platform !== "darwin") throw new Error("macOS Harness vendoring requires macOS to verify its packaged approval policy.");

  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-desktop-vendor-"));
  try {
    run("hdiutil", ["attach", file, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    const appPath = findApp(mountPoint);
    if (!appPath) {
      throw new Error(`Downloaded TritonAI Harness image does not contain an app bundle: ${file}`);
    }
    verifyExpectedMacHarnessPublisher(appPath);
    verifyPackagedCodexPolicy(path.join(appPath, "Contents", "Resources"), "app.asar");
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function verifyExpectedMacHarnessPublisher(
  appPath,
  executeCodesign = run,
  readBundleIdentifier = readMacHarnessBundleIdentifier
) {
  assertExpectedMacHarnessBundleIdentifier(readBundleIdentifier(appPath));
  for (const args of macHarnessCodesignVerificationArgs(appPath)) {
    executeCodesign(MACOS_CODESIGN_PATH, args);
  }
}

function verifyExpectedWindowsHarnessPublisher(
  executablePath,
  { platform = process.platform, execute = execFileSync } = {}
) {
  if (platform !== "win32") {
    throw new Error("Stable Windows Harness vendoring and publisher verification must run on Windows.");
  }
  const verifier = path.join(root, "scripts", "verify-windows-authenticode.ps1");
  const encodedPaths = Buffer.from(JSON.stringify([executablePath]), "utf8").toString("base64");
  const output = execute("pwsh.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    verifier,
    "-ExpectedPublisherName",
    EXPECTED_WINDOWS_PUBLISHER_NAME,
    "-EncodedPaths",
    encodedPaths
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const results = JSON.parse(String(output));
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    path.resolve(results[0].path).toLowerCase() !== path.resolve(executablePath).toLowerCase() ||
    results[0].status !== "Valid" ||
    results[0].publisherName !== EXPECTED_WINDOWS_PUBLISHER_NAME ||
    !results[0].thumbprint ||
    !results[0].timestampSubject
  ) {
    throw new Error(`TritonAI Harness Windows publisher verification returned invalid evidence for ${executablePath}.`);
  }
  return results[0];
}

function readMacHarnessBundleIdentifier(appPath) {
  return execFileSync(MACOS_PLUTIL_PATH, macHarnessBundleIdentifierPlistArgs(appPath), { encoding: "utf8" });
}

function findApp(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const direct = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (direct) return path.join(rootDir, direct.name);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findApp(path.join(rootDir, entry.name));
    if (nested) return nested;
  }

  return null;
}

function selectManifestFile(manifest, pattern) {
  const fileName = Object.keys(manifest.files || {}).find((entry) => pattern.test(entry));
  if (!fileName) {
    throw new Error(`TritonAI Harness manifest does not include an asset matching ${pattern}`);
  }
  return { fileName, expected: manifest.files[fileName] };
}

function parseLatestYml(text) {
  const result = { version: null, files: {} };
  let currentFile = null;

  for (const line of text.split(/\r?\n/)) {
    const versionMatch = line.match(/^version:\s+(.+)\s*$/);
    if (versionMatch) {
      result.version = cleanYamlValue(versionMatch[1]);
      continue;
    }

    const urlMatch = line.match(/^\s*-\s+url:\s+(.+)\s*$/);
    if (urlMatch) {
      currentFile = cleanYamlValue(urlMatch[1]);
      result.files[currentFile] = {};
      continue;
    }

    const propertyMatch = line.match(/^\s+(sha512|size):\s+(.+)\s*$/);
    if (currentFile && propertyMatch) {
      const [, key, rawValue] = propertyMatch;
      result.files[currentFile][key] = key === "size"
        ? Number(cleanYamlValue(rawValue))
        : cleanYamlValue(rawValue);
    }
  }

  return result;
}

function cleanYamlValue(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function sha512Base64(file) {
  const hash = crypto.createHash("sha512");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("base64");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  downloadManifest,
  downloadVerified,
  activateStagedVendors,
  activatePreparedVendors,
  markLocalReleaseCandidate,
  downloadAndVerifyPluginComposition,
  assertExplicitHarnessSource,
  assertMatchingManifestVersions,
  assertManifestVersion,
  parseLatestYml,
  publishedPluginCompositionFile,
  readHarnessSourceEnvironment,
  pluginCompositionFile,
  readWindowsTrustMode,
  selectManifestFile,
  verifyPluginCompositionProof,
  verifyExpectedMacHarnessPublisher,
  verifyExpectedWindowsHarnessPublisher
};
