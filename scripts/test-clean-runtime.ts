const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const assert = require("assert");
const { ensurePrerequisites, NODE_VERSION } = require("../src/installer/prerequisites");
const { getPaths } = require("../src/installer/paths");

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-installer-runtime-"));
  const oldPath = process.env.PATH;

  try {
    process.env.PATH = minimalPath();
    const paths = getPaths(tempRoot, process.platform);
    const runtime = await ensurePrerequisites({
      paths,
      platform: process.platform,
      arch: process.arch,
      emit: () => {}
    });

    const nodeVersion = execFileSync(runtime.nodeBinary, ["--version"], { encoding: "utf8" }).trim();
    const npmVersion = execFileSync(runtime.nodeBinary, [runtime.npmCliJs, "--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${runtime.nodeBinDir}${path.delimiter}${process.env.PATH || ""}`
      }
    }).trim();

    assert.strictEqual(nodeVersion, `v${NODE_VERSION}`);
    assert.match(npmVersion, /^\d+\.\d+\.\d+$/);
    console.log(`Clean runtime test passed with Node ${nodeVersion} and npm ${npmVersion}`);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function minimalPath() {
  if (process.platform === "win32") return process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : "";
  return "/usr/bin:/bin";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
