const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const tag = process.argv[2];
const releaseDir = path.join(root, "artifacts", "macos-release");

function main() {
  if (!tag) {
    throw new Error("Usage: npm run release:github -- v0.1.0");
  }

  const assets = [
    ...files(".dmg"),
    path.join(releaseDir, "SHA256SUMS.txt")
  ].filter((file) => fs.existsSync(file));

  if (assets.length === 0) {
    throw new Error("No release assets found. Run npm run package:mac-release first.");
  }

  const exists = spawnSync("gh", ["release", "view", tag], {
    cwd: root,
    stdio: "ignore"
  }).status === 0;

  if (!exists) {
    run("gh", [
      "release",
      "create",
      tag,
      "--draft",
      "--title",
      `TritonAI Installer ${tag}`,
      "--notes",
      "macOS Developer ID signed and notarized DMG."
    ]);
  }

  run("gh", ["release", "upload", tag, ...assets, "--clobber"]);
  console.log(`Uploaded ${assets.length} asset(s) to GitHub release ${tag}.`);
}

function files(extension) {
  if (!fs.existsSync(releaseDir)) return [];
  return fs.readdirSync(releaseDir)
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => path.join(releaseDir, entry))
    .sort();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

main();
