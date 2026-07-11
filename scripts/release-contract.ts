const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const defaultRoot = path.resolve(__dirname, "..", "..");

function loadReleaseContract(root = defaultRoot) {
  const contractPath = path.join(root, "release-artifacts.json");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  if (contract.schemaVersion !== 1 || !Array.isArray(contract.artifacts) || contract.artifacts.length === 0) {
    throw new Error(`Invalid release artifact contract: ${contractPath}`);
  }
  if (typeof contract.checksumManifest !== "string" || path.isAbsolute(contract.checksumManifest)) {
    throw new Error("Release checksum manifest path must be repository-relative.");
  }
  return contract;
}

function requiredReleaseArtifacts({ root = defaultRoot, version, contract = loadReleaseContract(root) }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release version must be stable semver: ${version}`);
  }

  const artifacts = contract.artifacts.map((entry) => {
    const relativePath = entry.path.replaceAll("{version}", version);
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      throw new Error(`Release artifact path must remain repository-relative: ${relativePath}`);
    }
    const fileName = path.basename(relativePath);
    if (!entry.metadata && !fileName.startsWith("TritonAI-Installer-")) {
      throw new Error(`Release artifact must use the canonical TritonAI-Installer prefix: ${fileName}`);
    }
    return { ...entry, relativePath, fileName, absolutePath: path.join(root, relativePath) };
  });

  const names = artifacts.map((entry) => entry.fileName);
  if (new Set(names).size !== names.length) {
    throw new Error("Release artifact basenames must be unique for GitHub publication.");
  }
  return artifacts;
}

function writeReleaseChecksumManifest({ root = defaultRoot, version, contract = loadReleaseContract(root) }) {
  assertBundledHarnessVendorContract({ root });
  const artifacts = requiredReleaseArtifacts({ root, version, contract });
  const missing = artifacts.filter((entry) => !isRegularFile(entry.absolutePath));
  if (missing.length > 0) {
    throw new Error(`Missing required release artifacts: ${missing.map((entry) => entry.relativePath).join(", ")}`);
  }

  const lines = artifacts
    .map((entry) => `${sha256(entry.absolutePath)}  ${entry.fileName}`)
    .sort();
  const manifestPath = path.join(root, contract.checksumManifest);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${lines.join("\n")}\n`, "utf8");
  fs.renameSync(temporaryPath, manifestPath);
  verifyReleaseChecksumManifest({ root, version, contract });
  return { artifacts, manifestPath };
}

function assertBundledHarnessVendorContract({ root = defaultRoot }) {
  const manifests = [
    { target: "mac-arm64", manifest: "latest-mac.yml", extension: "dmg" },
    { target: "win-x64", manifest: "latest.yml", extension: "exe" }
  ].map((definition) => {
    const vendorDir = path.join(root, "vendor", "t3code-desktop", definition.target);
    const manifestPath = path.join(vendorDir, definition.manifest);
    if (!isRegularFile(manifestPath)) {
      throw new Error(`Missing bundled TritonAI Harness manifest: ${path.relative(root, manifestPath)}`);
    }
    const text = fs.readFileSync(manifestPath, "utf8");
    const version = text.match(/^version:\s+([^\s]+)\s*$/m)?.[1] || null;
    if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) {
      throw new Error(`Bundled TritonAI Harness ${definition.target} manifest has no stable version.`);
    }
    const arch = definition.target.split("-")[1];
    const expectedName = `TritonAI-Harness-${version}-${arch}.${definition.extension}`;
    if (!text.split(/\r?\n/).some((line) => line.trim() === `- url: ${expectedName}`)) {
      throw new Error(`Bundled TritonAI Harness ${definition.target} manifest is missing canonical asset ${expectedName}.`);
    }
    if (!isRegularFile(path.join(vendorDir, expectedName))) {
      throw new Error(`Missing bundled TritonAI Harness asset: ${definition.target}/${expectedName}`);
    }
    return { ...definition, version, expectedName };
  });
  if (manifests[0].version !== manifests[1].version) {
    throw new Error(`Bundled macOS and Windows TritonAI Harness versions must match; found ${manifests[0].version} and ${manifests[1].version}.`);
  }
  return { version: manifests[0].version, manifests };
}

function verifyReleaseChecksumManifest({ root = defaultRoot, version, contract = loadReleaseContract(root) }) {
  const artifacts = requiredReleaseArtifacts({ root, version, contract });
  const manifestPath = path.join(root, contract.checksumManifest);
  if (!isRegularFile(manifestPath)) throw new Error(`Missing release checksum manifest: ${contract.checksumManifest}`);
  const expected = artifacts
    .map((entry) => `${sha256(entry.absolutePath)}  ${entry.fileName}`)
    .sort();
  const actual = fs.readFileSync(manifestPath, "utf8").trim().split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Release checksum manifest does not exactly cover the required artifacts.");
  }
  for (const line of actual) {
    const fileName = line.replace(/^[a-f0-9]{64}\s+/, "");
    if (!fileName || path.isAbsolute(fileName) || fileName !== path.basename(fileName)) {
      throw new Error(`Checksum manifest entries must use relative basenames only: ${line}`);
    }
  }
  return { artifacts, manifestPath };
}

function assertReleaseSourceIdentity({ root = defaultRoot, tag, version, remoteTaggedCommit = null }) {
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package version ${version}; expected v${version}.`);
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  const headPackage = JSON.parse(git(root, ["show", "HEAD:package.json"]));
  if (headPackage.version !== version) {
    throw new Error(`Working package version ${version} does not match package.json at HEAD (${headPackage.version}).`);
  }
  const taggedCommit = git(root, ["rev-parse", `${tag}^{commit}`]);
  if (head !== taggedCommit) {
    throw new Error(`Release tag ${tag} points to ${taggedCommit}, but HEAD is ${head}.`);
  }
  if (remoteTaggedCommit && head !== remoteTaggedCommit) {
    throw new Error(`Remote release tag ${tag} points to ${remoteTaggedCommit}, but HEAD is ${head}.`);
  }
  return { head, taggedCommit, remoteTaggedCommit };
}

function assertReleaseMayBeUpdated(release) {
  const isDraft = release && typeof release.draft === "boolean" ? release.draft : release?.isDraft;
  if (release && isDraft !== true) {
    throw new Error("Refusing to modify an existing published GitHub release.");
  }
}

function isRegularFile(file) {
  return fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw new Error(`Could not verify release source identity with git ${args.join(" ")}: ${detail}`);
  }
}

function main() {
  const pkg = require(path.join(defaultRoot, "package.json"));
  const result = writeReleaseChecksumManifest({ root: defaultRoot, version: pkg.version });
  console.log(`Release checksum contract verified: ${path.relative(defaultRoot, result.manifestPath)}`);
}

if (require.main === module) main();

module.exports = {
  assertBundledHarnessVendorContract,
  assertReleaseMayBeUpdated,
  assertReleaseSourceIdentity,
  loadReleaseContract,
  requiredReleaseArtifacts,
  verifyReleaseChecksumManifest,
  writeReleaseChecksumManifest
};
