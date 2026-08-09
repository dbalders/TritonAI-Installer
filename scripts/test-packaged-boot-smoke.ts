const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertInstallMutationAllowed,
  readPackagedBootSmokeRequest,
  writePackagedBootSmokeMarker
} = require("../src/packaged-boot-smoke");

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-smoke-contract-"));
  try {
    assert.strictEqual(readPackagedBootSmokeRequest([], tempRoot), null);
    assert.throws(
      () => readPackagedBootSmokeRequest([
        `--tritonai-installer-smoke-marker=${path.join(tempRoot, "wrong-name.json")}`
      ], tempRoot),
      /direct child/
    );
    assert.throws(
      () => readPackagedBootSmokeRequest([
        `--tritonai-installer-smoke-marker=${path.join(tempRoot, "..", "tritonai-installer-smoke-escape.json")}`
      ], tempRoot),
      /direct child/
    );

    const markerPath = path.join(tempRoot, "tritonai-installer-smoke-fixture.json");
    const request = readPackagedBootSmokeRequest([
      `--tritonai-installer-smoke-marker=${markerPath}`
    ], tempRoot);
    assert.strictEqual(request.markerPath, markerPath);
    assert.strictEqual(request.userDataPath, `${markerPath}.userdata`);
    assert.throws(() => assertInstallMutationAllowed(request), /cannot start installation or mutate/);
    assert.doesNotThrow(() => assertInstallMutationAllowed(null));
    writePackagedBootSmokeMarker(request, {
      schemaVersion: 1,
      productName: "TritonAI Installer",
      version: "1.2.3",
      platform: process.platform,
      arch: process.arch,
      packaged: true,
      healthyForMs: 5_000,
      readyAt: "2026-08-06T00:00:00.000Z"
    });
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.strictEqual(marker.packaged, true);
    assert.strictEqual(marker.healthyForMs, 5_000);
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(markerPath).mode & 0o777, 0o600);
    assert.throws(() => writePackagedBootSmokeMarker(request, marker), /EEXIST/);
    assert.throws(
      () => readPackagedBootSmokeRequest([
        `--tritonai-installer-smoke-marker=${markerPath}`
      ], tempRoot),
      /already exists/
    );
    const occupiedMarker = path.join(tempRoot, "tritonai-installer-smoke-occupied.json");
    fs.mkdirSync(`${occupiedMarker}.userdata`);
    assert.throws(
      () => readPackagedBootSmokeRequest([
        `--tritonai-installer-smoke-marker=${occupiedMarker}`
      ], tempRoot),
      /user-data path already exists/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("Packaged boot smoke contract tests passed.");
}

main();
