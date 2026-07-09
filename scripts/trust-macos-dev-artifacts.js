const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const shouldOpen = process.argv.includes("--open");
const scanRoots = ["dist", "artifacts"].map((dir) => path.join(root, dir));
const trustedExtensions = new Set([".app", ".zip", ".dmg", ".pkg"]);

if (process.platform !== "darwin") {
  console.log("macOS dev trust step skipped: this command only applies on macOS.");
  process.exit(0);
}

const targets = findDevArtifacts(scanRoots);

if (targets.length === 0) {
  console.log("No macOS dev artifacts found under dist/ or artifacts/.");
  process.exit(0);
}

for (const target of targets) {
  removeQuarantine(target);
}

console.log(`Cleared quarantine metadata from ${targets.length} dev artifact(s).`);

if (shouldOpen) {
  const app = targets.find((target) => target.endsWith(".app"));
  if (!app) {
    throw new Error("No .app artifact found to open.");
  }

  const result = spawnSync("open", [app], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`open failed with exit code ${result.status}`);
  }
}

function findDevArtifacts(roots) {
  const results = [];

  for (const scanRoot of roots) {
    if (!fs.existsSync(scanRoot)) {
      continue;
    }
    walk(scanRoot, results);
  }

  return results.sort();
}

function walk(currentPath, results) {
  const stat = fs.statSync(currentPath);
  const extension = path.extname(currentPath);

  if (trustedExtensions.has(extension)) {
    results.push(currentPath);
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(currentPath)) {
    walk(path.join(currentPath, entry), results);
  }
}

function removeQuarantine(target) {
  const result = spawnSync("xattr", ["-dr", "com.apple.quarantine", target], {
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !result.stderr.includes("No such xattr")) {
    throw new Error(`Failed to clear quarantine from ${target}:\n${result.stderr}`);
  }

  console.log(`Trusted for local testing: ${path.relative(root, target)}`);
}
