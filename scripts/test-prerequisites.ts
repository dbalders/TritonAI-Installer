const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { getPaths } = require("../src/installer/paths");
const {
  NODE_BACKUP_PREFIX,
  NODE_STAGE_PREFIX,
  NODE_TRANSACTION_JOURNAL_FILE,
  NODE_VENDOR_SCHEMA_VERSION,
  NODE_VERSION,
  downloadFileAtomic,
  ensurePrerequisites,
  findBundledNodeArchive,
  getNodeDistribution,
  getNodeRuntimePaths,
  recoverInterruptedNodeRuntime,
  runExtractionCommand,
  shouldFallbackWindowsExtraction
} = require("../src/installer/prerequisites");
const { writeDirectoryTransactionJournal } = require("../src/installer/directory-transaction");

async function main() {
  await assertPackagedRuntimeIsRequiredAndInstalledTransactionally();
  assertInterruptedRuntimeActivationRestoresPreviousRuntime();
  await assertInterruptedDownloadRetriesWithoutPoisoningTarget();
  await assertDownloadTotalTimeoutPreservesExistingTarget();
  await assertDownloadSizeLimitRejectsOversizedPayload();
  await assertDownloadRedirectLimit();
  await assertExtractionWatchdogTerminatesTimedOutProcess();
  console.log("Installer prerequisite tests passed.");
}

async function assertExtractionWatchdogTerminatesTimedOutProcess() {
  assert.strictEqual(shouldFallbackWindowsExtraction({ code: "ETIMEDOUT" }), false);
  assert.strictEqual(shouldFallbackWindowsExtraction({ code: "ETERMINATE" }), false);
  assert.strictEqual(shouldFallbackWindowsExtraction(new Error("tar format failure")), true);
  await assert.rejects(
    runExtractionCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      () => {},
      { timeoutMs: 50 }
    ),
    (error) => error.code === "ETIMEDOUT" && /process tree was terminated/.test(error.message)
  );
}

function assertInterruptedRuntimeActivationRestoresPreviousRuntime() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-node-recovery-"));
  try {
    const paths = getPaths(path.join(tempRoot, "home"), "darwin");
    const nodePaths = getNodeRuntimePaths(paths, "darwin", "arm64");
    writeFakeNodeRuntime(nodePaths.nodeHome, "darwin");
    fs.writeFileSync(nodePaths.runtimeMarker, `${JSON.stringify({
      schemaVersion: NODE_VENDOR_SCHEMA_VERSION,
      name: "node",
      version: NODE_VERSION,
      target: "mac-arm64",
      archiveSha256: "a".repeat(64)
    })}\n`);
    const stageRoot = fs.mkdtempSync(path.join(paths.nodeRoot, NODE_STAGE_PREFIX));
    const backupRoot = fs.mkdtempSync(path.join(paths.nodeRoot, NODE_BACKUP_PREFIX));
    const previousNodeHome = path.join(backupRoot, nodePaths.nodeDirName);
    fs.renameSync(nodePaths.nodeHome, previousNodeHome);
    fs.mkdirSync(nodePaths.nodeHome, { recursive: true });
    fs.writeFileSync(path.join(nodePaths.nodeHome, "partial"), "interrupted");
    const journalPath = path.join(paths.nodeRoot, NODE_TRANSACTION_JOURNAL_FILE);
    writeDirectoryTransactionJournal({
      journalPath,
      kind: "managed Node.js runtime",
      target: nodePaths.nodeHome,
      stageRoot,
      backupRoot,
      stagePrefix: NODE_STAGE_PREFIX,
      backupPrefix: NODE_BACKUP_PREFIX,
      stagedName: nodePaths.nodeDirName,
      backupName: nodePaths.nodeDirName,
      hadPrevious: true
    });

    assert.deepStrictEqual(recoverInterruptedNodeRuntime({
      paths,
      nodePaths,
      platform: "darwin",
      arch: "arm64",
      emit: () => {}
    }), { recovered: true, action: "rolled-back" });
    assert(fs.existsSync(nodePaths.nodeBinary));
    assert(fs.existsSync(nodePaths.runtimeMarker));
    assert(!fs.existsSync(stageRoot));
    assert(!fs.existsSync(backupRoot));
    assert(!fs.existsSync(journalPath));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertPackagedRuntimeIsRequiredAndInstalledTransactionally() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-node-vendor-"));
  try {
    const homeDir = path.join(tempRoot, "home");
    const resourcesPath = path.join(tempRoot, "resources");
    const paths = getPaths(homeDir, "darwin");
    const distribution = getNodeDistribution("darwin", "arm64");
    const vendorDir = path.join(resourcesPath, "vendor", "node-runtime", "mac-arm64");
    const archivePath = path.join(vendorDir, distribution.archiveName);
    fs.mkdirSync(vendorDir, { recursive: true });
    const archiveBytes = Buffer.from("fixture node archive");
    fs.writeFileSync(archivePath, archiveBytes);
    fs.writeFileSync(path.join(vendorDir, "manifest.json"), JSON.stringify({
      schemaVersion: NODE_VENDOR_SCHEMA_VERSION,
      name: "node",
      version: NODE_VERSION,
      target: "mac-arm64",
      archive: {
        name: distribution.archiveName,
        size: archiveBytes.length,
        sha256: crypto.createHash("sha256").update(archiveBytes).digest("hex")
      }
    }));

    assert(findBundledNodeArchive({ platform: "darwin", arch: "arm64", resourcesPath }));
    let extractionCount = 0;
    const extractArchive = async ({ destination }) => {
      extractionCount += 1;
      writeFakeNodeRuntime(path.join(destination, distribution.nodeDirName), "darwin");
    };
    const runtime = await ensurePrerequisites({
      paths,
      platform: "darwin",
      arch: "arm64",
      emit: () => {},
      resourcesPath,
      packaged: true,
      extractArchive
    });
    assert.strictEqual(extractionCount, 1);
    assert(fs.existsSync(runtime.runtimeMarker));

    await ensurePrerequisites({
      paths,
      platform: "darwin",
      arch: "arm64",
      emit: () => {},
      resourcesPath,
      packaged: true,
      extractArchive
    });
    assert.strictEqual(extractionCount, 1, "a validated managed runtime must be reused");

    fs.writeFileSync(runtime.runtimeMarker, "{}\n");
    await ensurePrerequisites({
      paths,
      platform: "darwin",
      arch: "arm64",
      emit: () => {},
      resourcesPath,
      packaged: true,
      extractArchive
    });
    assert.strictEqual(extractionCount, 2, "an invalid runtime marker must trigger a clean replacement");

    const missingPaths = getPaths(path.join(tempRoot, "missing-home"), "darwin");
    await assert.rejects(
      ensurePrerequisites({
        paths: missingPaths,
        platform: "darwin",
        arch: "arm64",
        emit: () => {},
        resourcesPath: path.join(tempRoot, "missing-resources"),
        appRoot: path.join(tempRoot, "missing-app"),
        packaged: true,
        extractArchive
      }),
      /missing a valid bundled Node\.js runtime/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertInterruptedDownloadRetriesWithoutPoisoningTarget() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-atomic-download-"));
  const target = path.join(tempRoot, "runtime.zip");
  const payload = Buffer.from("complete runtime payload");
  fs.writeFileSync(target, "previous complete target");
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-length": payload.length });
    response.end(requests === 1 ? payload.subarray(0, 5) : payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await downloadFileAtomic(`http://127.0.0.1:${address.port}/runtime.zip`, target, () => {}, {
      attempts: 2,
      timeoutMs: 2_000,
      requestFactory: http.get
    });
    assert.strictEqual(fs.readFileSync(target, "utf8"), payload.toString("utf8"));
    assert.strictEqual(requests, 2, "an incomplete response must be retried");
    assert.deepStrictEqual(
      fs.readdirSync(tempRoot).filter((entry) => entry.includes(".partial-")),
      [],
      "failed attempts must not leave poison cache files"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertDownloadTotalTimeoutPreservesExistingTarget() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-bounded-download-"));
  const target = path.join(tempRoot, "runtime.zip");
  fs.writeFileSync(target, "previous verified target");
  let interval;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-length": 10_000 });
    interval = setInterval(() => response.write("x"), 10);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await assert.rejects(
      downloadFileAtomic(`http://127.0.0.1:${address.port}/runtime.zip`, target, () => {}, {
        attempts: 1,
        timeoutMs: 1_000,
        totalTimeoutMs: 75,
        requestFactory: http.get
      }),
      /total timeout/
    );
    assert.strictEqual(fs.readFileSync(target, "utf8"), "previous verified target");
    assert.deepStrictEqual(
      fs.readdirSync(tempRoot).filter((entry) => entry.includes(".partial-")),
      [],
      "timed-out downloads must not leave partial files"
    );
  } finally {
    clearInterval(interval);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertDownloadSizeLimitRejectsOversizedPayload() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-sized-download-"));
  const target = path.join(tempRoot, "manifest.yml");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-length": 20 });
    response.end("12345678901234567890");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await assert.rejects(
      downloadFileAtomic(`http://127.0.0.1:${address.port}/manifest.yml`, target, () => {}, {
        attempts: 1,
        timeoutMs: 1_000,
        totalTimeoutMs: 1_000,
        maxBytes: 10,
        requestFactory: http.get
      }),
      /10-byte limit/
    );
    assert(!fs.existsSync(target));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertDownloadRedirectLimit() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-redirect-download-"));
  const target = path.join(tempRoot, "manifest.yml");
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(302, { location: "/redirect-again" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await assert.rejects(
      downloadFileAtomic(`http://127.0.0.1:${address.port}/start`, target, () => {}, {
        attempts: 1,
        timeoutMs: 1_000,
        totalTimeoutMs: 1_000,
        requestFactory: http.get
      }),
      /Too many or invalid redirects/
    );
    assert.strictEqual(requests, 6, "the initial request plus five redirects are allowed");
    assert(!fs.existsSync(target));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function writeFakeNodeRuntime(nodeHome, platform) {
  const binDir = platform === "win32" ? nodeHome : path.join(nodeHome, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, platform === "win32" ? "node.exe" : "node"), "node", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, platform === "win32" ? "npm.cmd" : "npm"), "npm", { mode: 0o755 });
  const npmCli = getNodeRuntimePaths({ nodeRoot: path.dirname(nodeHome) }, platform, platform === "win32" ? "x64" : "arm64").npmCliJs;
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(npmCli, "npm cli");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
