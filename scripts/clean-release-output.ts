const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const target = process.argv[2];
const targets = {
  mac: path.join(root, "artifacts", "macos-release"),
  win: path.join(root, "artifacts", "windows-installer")
};

if (!targets[target]) {
  throw new Error("Usage: node dist/scripts/clean-release-output.js <mac|win>");
}

fs.rmSync(targets[target], { recursive: true, force: true });
fs.rmSync(path.join(root, "artifacts", "SHA256SUMS.txt"), { force: true });
console.log(`Cleaned ${path.relative(root, targets[target])} before packaging.`);
