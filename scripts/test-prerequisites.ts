const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { getPaths } = require("../src/installer/paths");
const {
  NODE_BACKUP_PREFIX,
  NODE_STAGE_PREFIX,
  NODE_TRANSACTION_JOURNAL_FILE,
  NODE_VENDOR_SCHEMA_VERSION,
  NODE_VERSION,
  NODE_ARCHIVE_SHA256,
  downloadFileAtomic,
  ensurePrerequisites,
  findBundledNodeArchive,
  getNodeDistribution,
  getNodeRuntimePaths,
  installNodeRuntimeFromArchive,
  recoverInterruptedNodeRuntime,
  runExtractionCommand,
  shouldFallbackWindowsExtraction
} = require("../src/installer/prerequisites");
const { writeDirectoryTransactionJournal } = require("../src/installer/directory-transaction");

async function main() {
  assertReviewedNodeArchiveDigests();
  await assertPackagedRuntimeIsRequiredAndInstalledTransactionally();
  await assertWindowsRuntimeRenamesRetryTransientErrors();
  await assertWindowsRuntimeBackupAndRollbackRetry();
  await assertRuntimeRenameFailuresStayBounded();
  await assertFailedRollbackRetainsRecovery();
  await assertNativeWindowsRuntimeLockCanBeReleased();
  assertInterruptedRuntimeActivationRestoresPreviousRuntime();
  await assertInterruptedDownloadRetriesWithoutPoisoningTarget();
  await assertDownloadTotalTimeoutPreservesExistingTarget();
  await assertDownloadSizeLimitRejectsOversizedPayload();
  await assertDownloadRedirectLimit();
  await assertExtractionWatchdogTerminatesTimedOutProcess();
  console.log("Installer prerequisite tests passed.");
}

function assertReviewedNodeArchiveDigests() {
  assert.deepStrictEqual(NODE_ARCHIVE_SHA256, {
    "mac-arm64": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
    "win-x64": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
  });
  assert.strictEqual(getNodeDistribution("darwin", "arm64").sha256, NODE_ARCHIVE_SHA256["mac-arm64"]);
  assert.strictEqual(getNodeDistribution("win32", "x64").sha256, NODE_ARCHIVE_SHA256["win-x64"]);
}

async function withRuntimeRenameFixture(platform, run) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-node-rename-"));
  const paths = getPaths(path.join(tempRoot, "home"), platform);
  const arch = platform === "win32" ? "x64" : "arm64";
  const nodePaths = getNodeRuntimePaths(paths, platform, arch);
  const archivePath = path.join(tempRoot, "runtime.archive");
  fs.writeFileSync(archivePath, "fixture archive");
  const expectedSha256 = crypto.createHash("sha256").update("fixture archive").digest("hex");
  const install = ({ emit = (_message) => {}, afterExtraction = async (_home) => {} } = {}) =>
    installNodeRuntimeFromArchive({
      archivePath, expectedSha256, paths, platform, arch, nodePaths, emit,
      archiveExtractor: async ({ destination }) => {
        const home = path.join(destination, nodePaths.nodeDirName);
        writeFakeNodeRuntime(home, platform);
        await afterExtraction(home);
      }
    });
  const rename = fs.renameSync;
  try {
    await run({ tempRoot, paths, nodePaths, install, rename });
  } finally {
    fs.renameSync = rename;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertWindowsRuntimeRenamesRetryTransientErrors() {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    await withRuntimeRenameFixture("win32", async ({ paths, nodePaths, install, rename }) => {
      let attempts = 0;
      const messages: string[] = [];
      fs.renameSync = (from, to) => {
        if (to === nodePaths.nodeHome && from.includes(NODE_STAGE_PREFIX) && ++attempts === 1) {
          throw Object.assign(new Error("temporary rename denial"), { code });
        }
        return rename(from, to);
      };
      await install({ emit: (message) => messages.push(message) });
      assert.strictEqual(attempts, 2, `${code} must be retried`);
      assert(messages.some((message) => message.includes(code) && message.includes("retrying")));
      assert.strictEqual(fs.readFileSync(nodePaths.nodeBinary, "utf8"), "node");
      assert.strictEqual(JSON.parse(fs.readFileSync(nodePaths.runtimeMarker, "utf8")).target, "win-x64");
      assert.deepStrictEqual(fs.readdirSync(paths.nodeRoot), [nodePaths.nodeDirName]);
    });
  }
}

async function assertWindowsRuntimeBackupAndRollbackRetry() {
  await withRuntimeRenameFixture("win32", async ({ paths, nodePaths, install, rename }) => {
    await install();
    fs.writeFileSync(nodePaths.nodeBinary, "previous node");
    let backups = 0;
    let rollbacks = 0;
    const failure = Object.assign(new Error("activation failed"), { code: "EIO" });
    fs.renameSync = (from, to) => {
      if (from === nodePaths.nodeHome && ++backups === 1) {
        throw Object.assign(new Error("backup locked"), { code: "EBUSY" });
      }
      if (from.includes(NODE_STAGE_PREFIX)) throw failure;
      if (from.includes(NODE_BACKUP_PREFIX) && ++rollbacks === 1) {
        throw Object.assign(new Error("rollback locked"), { code: "EACCES" });
      }
      return rename(from, to);
    };
    await assert.rejects(install(), (error) => error === failure);
    assert.strictEqual(backups, 2);
    assert.strictEqual(rollbacks, 2);
    assert.strictEqual(fs.readFileSync(nodePaths.nodeBinary, "utf8"), "previous node");
    assert.deepStrictEqual(fs.readdirSync(paths.nodeRoot), [nodePaths.nodeDirName]);
  });
}

async function assertRuntimeRenameFailuresStayBounded() {
  for (const { platform, code, previous, attempts: expectedAttempts } of [
    { platform: "win32", code: "EPERM", previous: false, attempts: 6 },
    { platform: "win32", code: "EPERM", previous: true, attempts: 6 },
    { platform: "win32", code: "ENOENT", previous: false, attempts: 1 },
    { platform: "win32", code: "EIO", previous: false, attempts: 1 },
    { platform: "darwin", code: "EPERM", previous: false, attempts: 1 }
  ]) {
    await withRuntimeRenameFixture(platform, async ({ paths, nodePaths, install, rename }) => {
      if (previous) {
        await install();
        fs.writeFileSync(nodePaths.nodeBinary, "previous node");
      }
      const failure = Object.assign(new Error("rename denied"), { code });
      let attempts = 0;
      const messages: string[] = [];
      fs.renameSync = (from, to) => {
        if (from.includes(NODE_STAGE_PREFIX)) {
          attempts += 1;
          throw failure;
        }
        return rename(from, to);
      };
      await assert.rejects(install({ emit: (message) => messages.push(message) }), (error) => error === failure);
      assert.strictEqual(attempts, expectedAttempts);
      assert.strictEqual(messages.length, expectedAttempts - 1);
      if (previous) assert.strictEqual(fs.readFileSync(nodePaths.nodeBinary, "utf8"), "previous node");
      else assert(!fs.existsSync(nodePaths.nodeHome), "a failed activation must not appear installed");
      assert.deepStrictEqual(fs.readdirSync(paths.nodeRoot), previous ? [nodePaths.nodeDirName] : []);
    });
  }
}

async function assertFailedRollbackRetainsRecovery() {
  await withRuntimeRenameFixture("win32", async ({ paths, nodePaths, install, rename }) => {
    await install();
    fs.writeFileSync(nodePaths.nodeBinary, "previous node");
    let rollbacks = 0;
    fs.renameSync = (from, to) => {
      if (from.includes(NODE_STAGE_PREFIX)) throw new Error("activation failed");
      if (from.includes(NODE_BACKUP_PREFIX)) {
        rollbacks += 1;
        throw Object.assign(new Error("rollback locked"), { code: "EPERM" });
      }
      return rename(from, to);
    };
    await assert.rejects(install(), /Rollback also failed: rollback locked/);
    assert.strictEqual(rollbacks, 6);
    assert(fs.existsSync(path.join(paths.nodeRoot, NODE_TRANSACTION_JOURNAL_FILE)));
    fs.renameSync = rename;
    recoverInterruptedNodeRuntime({ paths, nodePaths, platform: "win32", arch: "x64", emit: () => {} });
    assert.strictEqual(fs.readFileSync(nodePaths.nodeBinary, "utf8"), "previous node");
    assert.deepStrictEqual(fs.readdirSync(paths.nodeRoot), [nodePaths.nodeDirName]);
  });
}

async function assertNativeWindowsRuntimeLockCanBeReleased() {
  if (process.platform !== "win32") return;
  await withRuntimeRenameFixture("win32", async ({ tempRoot, nodePaths, install }) => {
    const releasePath = path.join(tempRoot, "release-lock");
    let holder;
    let closed;
    let retries = 0;
    try {
      await install({
        afterExtraction: async (home) => {
          // FileShare.ReadWrite deliberately omits Delete, preventing the directory rename.
          holder = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; "
            + "$handle=[IO.File]::Open($env:TRITONAI_TEST_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); "
            + "try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); "
            + "$deadline=[DateTime]::UtcNow.AddSeconds(15); "
            + "while (!(Test-Path -LiteralPath $env:TRITONAI_TEST_RELEASE_FILE) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 } "
            + "} finally { $handle.Dispose() }"
          ], {
            windowsHide: true,
            env: { ...process.env, TRITONAI_TEST_LOCK_FILE: path.join(home, "node.exe"), TRITONAI_TEST_RELEASE_FILE: releasePath }
          });
          closed = new Promise((resolve) => holder.once("close", resolve));
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Windows lock fixture did not become ready")), 10_000);
            let output = "";
            let stderr = "";
            const finish = (error = null) => { clearTimeout(timer); error ? reject(error) : resolve(); };
            holder.stdout.on("data", (chunk) => {
              output += chunk.toString();
              if (output.includes("LOCKED")) finish();
            });
            holder.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
            holder.once("error", finish);
            holder.once("close", (code) => finish(new Error(`Windows lock fixture exited (${code}): ${stderr}`)));
          });
        },
        emit: (message) => {
          if (message.includes("retrying")) {
            retries += 1;
            fs.writeFileSync(releasePath, "release");
          }
        }
      });
      assert(retries > 0, "a real Windows file handle must block the initial activation");
      assert.strictEqual(fs.readFileSync(nodePaths.nodeBinary, "utf8"), "node");
      assert(fs.existsSync(nodePaths.runtimeMarker));
      console.log("Native Windows Node runtime lock/retry test passed.");
    } finally {
      if (holder) {
        fs.writeFileSync(releasePath, "release");
        const timer = setTimeout(() => holder.kill(), 5_000);
        try { await closed; } finally { clearTimeout(timer); }
      }
    }
  });
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
