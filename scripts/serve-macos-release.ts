const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const releaseDir = path.join(root, "artifacts", "macos-release");
const pkg = require(path.join(root, "package.json"));
const dmgName = `TritonAI-Installer-${pkg.version}-arm64.dmg`;
const dmgPath = path.join(releaseDir, dmgName);
const port = Number(process.env.PORT || process.argv[2] || 8790);

function main() {
  assertReleaseArtifact();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== `/${dmgName}` && url.pathname !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Only the notarized macOS release DMG is served here.\n");
      return;
    }

    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<a href="/${dmgName}">${dmgName}</a>\n`);
      return;
    }

    response.writeHead(200, {
      "content-type": "application/x-apple-diskimage",
      "content-length": fs.statSync(dmgPath).size
    });
    fs.createReadStream(dmgPath).pipe(response);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log("Serving notarized macOS release DMG only.");
    console.log(`Local path: ${dmgPath}`);
    for (const host of hostAddresses()) {
      console.log(`URL: http://${host}:${port}/${dmgName}`);
    }
  });
}

function assertReleaseArtifact() {
  if (!fs.existsSync(dmgPath)) {
    throw new Error(`Missing release DMG: ${dmgPath}\nRun npm run package:mac-release first.`);
  }

  run("xcrun", ["stapler", "validate", dmgPath]);
  run("hdiutil", ["verify", dmgPath]);
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
}

main();
