import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { assertInstallerSender, documentationUrl, installedLaunchTarget } from "../src/installer/ipc-policy";
import { fileDigest } from "../src/installer/file-digest";
const { __test: { requestJson, MAX_JSON_RESPONSE_BYTES } } = require("../src/installer/tritonai-connection");
const { createDiagnosticsSession, redactSensitive } = require("../src/installer/diagnostics");
const { selectMacDmg, parseLatestYml } = require("../src/installer/t3code-desktop");
const { createDiagnosticEmitter, writeSupportReportSafely } = require("../src/installer/runner");
const { hasNativeCodexExecutable, codexTargetName } = require("../src/installer/codex-vendor");
const { checkAndAssignCredentials } = require("../src/installer/credentials");

async function main() {
  assert.equal(codexTargetName("darwin", "arm64"), "mac-arm64");
  assert.equal(codexTargetName("win32", "x64"), "win-x64");
  assert.throws(() => codexTargetName("darwin", "x64"), /Unsupported/);
  const renderer = path.resolve("renderer with spaces", "index.html");
  const frame = { url: pathToFileURL(renderer).href };
  const contents: any = { mainFrame: frame, isDestroyed: () => false };
  const event: any = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => assertInstallerSender(event, contents, renderer));
  for (const untrusted of [
    { ...event, sender: {} },
    { ...event, senderFrame: null },
    { ...event, senderFrame: { ...frame } }
  ]) assert.throws(() => assertInstallerSender(untrusted, contents, renderer), /main window/);
  frame.url = "https://example.com";
  assert.throws(() => assertInstallerSender(event, contents, renderer), /main window/);
  for (const url of ["file:///tmp/app", "javascript:alert(1)", "http://example.com", "https://user:password@example.com"]) {
    assert.throws(() => documentationUrl(url), /HTTPS/);
  }
  assert.equal(documentationUrl("https://example.com/docs"), "https://example.com/docs");
  assert.throws(() => installedLaunchTarget("t3code", null), /successful installation/);
  assert.throws(() => installedLaunchTarget("arbitrary-tool", {}), /successful installation/);
  assert.equal(installedLaunchTarget("t3code", { t3codeShortcut: "/managed/launcher" }), "/managed/launcher");

  for (const apiKeys of [null, {}, "key", ["a", "b", "c"], [123], ["a\nb"], ["x".repeat(4097)]]) {
    await assert.rejects(checkAndAssignCredentials({ apiKeys, checkConnection: () => assert.fail("invalid input reached the network") }), /valid TritonAI access keys/);
  }

  assert.throws(() => selectMacDmg({ version: "../../escape", files: {} }, "arm64"), /stable semantic version/);
  for (const expected of [{ sha512: "abc", size: 1 }, { sha512: "A".repeat(86) + "==", size: NaN }, { sha512: "A".repeat(86) + "==", size: -1 }]) {
    assert.throws(() => selectMacDmg({ version: "1.0.0", files: { "TritonAI-Harness-1.0.0-arm64.dmg": expected } }, "arm64"), /checksum metadata/);
  }
  assert.throws(() => parseLatestYml("version: 1.0.0\nfiles:\n  - url: duplicate\n  - url: duplicate\n"), /duplicate/);
  await assertNetworkLifecycle();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installer-reliability-"));
  try {
    for (const platform of ["darwin", "win32"]) {
      const nativeRoot = path.join(root, platform);
      const nativeBin = path.join(nativeRoot, "vendor", platform === "win32" ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin", "bin");
      const executable = path.join(nativeBin, platform === "win32" ? "codex.exe" : "codex");
      fs.mkdirSync(nativeBin, { recursive: true });
      assert.equal(hasNativeCodexExecutable(nativeRoot, platform), false);
      fs.writeFileSync(executable, "");
      assert.equal(hasNativeCodexExecutable(nativeRoot, platform), false);
      fs.writeFileSync(executable, "native fixture");
      assert.equal(hasNativeCodexExecutable(nativeRoot, platform), true);
    }
    const file = path.join(root, "payload");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x93);
    fs.writeFileSync(file, bytes);
    for (const algorithm of ["sha256", "sha512"] as const) {
      for (const encoding of ["hex", "base64"] as const) {
        assert.equal(fileDigest(file, algorithm, encoding), createHash(algorithm).update(bytes).digest(encoding));
      }
    }
    fs.writeFileSync(file, "");
    assert.equal(fileDigest(file, "sha256", "hex"), createHash("sha256").digest("hex"));

    const paths = { logsDir: path.join(root, "logs"), codexBinDir: root };
    const first = createDiagnosticsSession({ paths, secretValues: ["secret", "secret-longer"] });
    const second = createDiagnosticsSession({ paths });
    assert.notEqual(first.logFile, second.logFile, "rapid retries must not overwrite earlier diagnostics");
    for (let index = 0; index < 250; index++) first.append(`event ${index} secret-longer`);
    const info = first.writeSupportReport({ ok: true });
    const report = JSON.parse(fs.readFileSync(info.supportReportFile, "utf8"));
    assert.equal(report.events.length, 200);
    assert.equal(report.events[0].message, "event 50 [redacted]");
    assert.ok(!fs.readFileSync(first.logFile, "utf8").includes("-longer"));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(first.logFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(info.supportReportFile).mode & 0o777, 0o600);
    }
    for (const key of ["TRITONAI_API_KEY", "TRITONAI_ONPREM_API_KEY", "TRITONAI_FRONTIER_API_KEY"]) {
      assert.ok(!redactSensitive(`${key}='sensitive-value'`).includes("sensitive-value"));
      assert.ok(!redactSensitive(JSON.stringify({ [key]: "sensitive-value" })).includes("sensitive-value"));
    }
    fs.writeFileSync(path.join(root, "not-a-directory"), "fixture");
    const previousError = console.error;
    console.error = () => {};
    try {
      const unavailable = createDiagnosticsSession({ paths: { ...paths, logsDir: path.join(root, "not-a-directory", "logs") } });
      let delivered = false;
      assert.doesNotThrow(() => createDiagnosticEmitter(() => { delivered = true; }, unavailable)("installation continues"));
      assert.equal(delivered, true);
      assert.equal(writeSupportReportSafely(unavailable, { ok: true }).reportAvailable, false);
      assert.equal(unavailable.fallbackInfo(false).reportAvailable, false);
    } finally { console.error = previousError; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log("Installer IPC, network, diagnostics, and artifact hashing tests passed.");
}

async function assertNetworkLifecycle() {
  async function requestWith(deliver, expectedError?: RegExp) {
    const request: any = new EventEmitter();
    const response: any = new EventEmitter();
    response.statusCode = 200;
    let stopped = false;
    let pulse;
    request.destroy = response.destroy = () => { stopped = true; clearInterval(pulse); };
    request.setTimeout = () => {}; // Simulate a peer that never becomes idle.
    request.end = () => {};
    const promise = requestJson({
      url: new URL("https://example.invalid/v1/models"), apiKey: "fixture", timeoutMs: 100,
      requestFactory: (_url, _options, callback) => {
        setImmediate(() => {
          callback(response);
          pulse = deliver(response);
        });
        return request;
      }
    });
    try {
      if (expectedError) {
        await assert.rejects(promise, expectedError);
        assert.ok(stopped, "failed requests must release the active transport");
      } else {
        assert.deepEqual(await promise, { statusCode: 200, body: { data: [] } });
      }
    } finally { clearInterval(pulse); }
  }
  await requestWith((response) => { response.emit("data", '{"data":[]}'); response.emit("end"); });
  await requestWith((response) => response.emit("aborted"), /interrupted/);
  await requestWith((response) => response.emit("error", new Error("reset")), /reset/);
  await requestWith((response) => response.emit("close"), /before completion/);
  await requestWith((response) => response.emit("data", Buffer.alloc(MAX_JSON_RESPONSE_BYTES + 1)), /large response/);
  await requestWith((response) => setInterval(() => response.emit("data", " "), 5), /timed out/);
  await assert.rejects(requestJson({
    url: new URL("https://example.invalid"), apiKey: "fixture", timeoutMs: 100,
    requestFactory: () => { throw new Error("request creation failed"); }
  }), /request creation failed/);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
