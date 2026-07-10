const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  assertReleaseMayBeUpdated,
  assertReleaseSourceIdentity,
  writeReleaseChecksumManifest
} = require("./release-contract");

const root = path.resolve(__dirname, "..", "..");
const tag = process.argv[2];
const pkg = require(path.join(root, "package.json"));

function main() {
  if (!tag) {
    throw new Error("Usage: npm run release:github -- v0.1.0");
  }

  const sourceIdentity = assertReleaseSourceIdentity({
    root,
    tag,
    version: pkg.version,
    remoteTaggedCommit: getRemoteTagCommit(tag)
  });
  const releaseState = getReleaseState(tag);
  assertReleaseMayBeUpdated(releaseState);
  const contract = writeReleaseChecksumManifest({ root, version: pkg.version });
  const assets = [
    ...contract.artifacts.map((entry) => entry.absolutePath),
    contract.manifestPath
  ];

  if (!releaseState) {
    run("gh", [
      "release",
      "create",
      tag,
      "--draft",
      "--target",
      sourceIdentity.head,
      "--title",
      `TritonAI Installer ${tag}`,
      "--notes",
      "macOS and Windows TritonAI Installer artifacts."
    ]);
  }

  run("gh", ["release", "upload", tag, ...assets]);
  console.log(`Uploaded ${assets.length} asset(s) to GitHub release ${tag}.`);
}

function getRemoteTagCommit(releaseTag) {
  const result = spawnSync("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${releaseTag}`,
    `refs/tags/${releaseTag}^{}`
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect remote release tag ${releaseTag}: ${String(result.stderr || "").trim()}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${releaseTag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${releaseTag}`));
  return (peeled || direct || "").split(/\s+/)[0] || null;
}

function getReleaseState(releaseTag) {
  const result = spawnSync("gh", ["release", "view", releaseTag, "--json", "isDraft"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

if (require.main === module) main();

module.exports = { getRemoteTagCommit };
