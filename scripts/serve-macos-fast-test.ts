const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const artifactDir = path.join(root, "artifacts", "macos-fast-test");
const pkg = require(path.join(root, "package.json"));
const zipName = `TritonAI-Installer-${pkg.version}-arm64-fast-test.zip`;
const appPath = path.join(artifactDir, "mac-arm64", "TritonAI Installer.app");
const port = Number(process.env.PORT || process.argv[2] || 8791);

function main() {
  assertFastArtifact();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== `/${zipName}` && url.pathname !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Only the fast macOS test zip is served here.\n");
      return;
    }

    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<a href="/${zipName}">${zipName}</a>\n`);
      return;
    }

    if (request.method === "HEAD") {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${zipName}"`
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${zipName}"`
    });
    streamAppZip(response);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log("Serving unnotarized macOS fast-test app zip.");
    console.log(`Local path: ${appPath}`);
    console.log("In the VM, unzip it and clear quarantine if macOS blocks it:");
    console.log(`xattr -dr com.apple.quarantine ~/Downloads/${zipName}`);
    for (const host of hostAddresses()) {
      console.log(`URL: http://${host}:${port}/${zipName}`);
    }
  });
}

function assertFastArtifact() {
  if (!fs.existsSync(appPath)) {
    throw new Error(`Missing fast-test app: ${appPath}\nRun npm run package:mac-fast-test first.`);
  }
}

function streamAppZip(response) {
  const zipper = spawn("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    "-"
  ], {
    cwd: artifactDir,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  zipper.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  zipper.stdout.pipe(response);
  zipper.on("error", (error) => {
    response.destroy(error);
  });
  zipper.on("close", (code) => {
    if (code !== 0) {
      response.destroy(new Error(`ditto failed with exit code ${code}: ${stderr}`));
    }
  });
}

function hostAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces() as Record<string, Array<{ family: string; internal: boolean; address: string }> | undefined>;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses.length ? addresses : ["127.0.0.1"];
}

main();
