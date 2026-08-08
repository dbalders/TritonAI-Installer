const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getPaths } = require("../src/installer/paths");
const {
  checkInstallCapacity,
  MINIMUM_FREE_BYTES,
  PAYLOAD_EXPANSION_FACTOR,
  ROLLBACK_RESERVE_BYTES
} = require("../src/installer/install-preflight");

function main() {
  assertCapacityUsesBundledPayloadAndRollbackReserve();
  assertLowCapacityFailsBeforeMutation();
  console.log("Installer disk preflight tests passed.");
}

function assertCapacityUsesBundledPayloadAndRollbackReserve() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-capacity-"));
  try {
    const homeDir = path.join(tempRoot, "future-home");
    const resourcesPath = path.join(tempRoot, "resources");
    const vendorDir = path.join(resourcesPath, "vendor");
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, "payload.bin"), Buffer.alloc(1024));
    const emitted = [];
    const result = checkInstallCapacity({
      paths: getPaths(homeDir, "darwin"),
      resourcesPath,
      emit: (message) => emitted.push(message),
      statfs: () => ({ bavail: 10 * 1024, bsize: 1024 * 1024 }),
      directorySize: () => 2 * 1024 ** 3
    });

    assert.strictEqual(result.bundledBytes, 2 * 1024 ** 3);
    assert.strictEqual(
      result.requiredBytes,
      (result.bundledBytes * PAYLOAD_EXPANSION_FACTOR) + ROLLBACK_RESERVE_BYTES
    );
    assert(emitted.some((message) => message.includes("staging, and rollback")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertLowCapacityFailsBeforeMutation() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-capacity-low-"));
  try {
    const homeDir = path.join(tempRoot, "home-not-created");
    assert.throws(
      () => checkInstallCapacity({
        paths: getPaths(homeDir, "win32"),
        emit: () => {},
        statfs: () => ({ bavail: 1, bsize: 1024 })
      }),
      /Not enough free disk space.*no existing managed runtime or application files were changed/
    );
    assert(!fs.existsSync(homeDir), "capacity failure must not create the target home or managed folders");
    assert.strictEqual(MINIMUM_FREE_BYTES, 3 * 1024 ** 3);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
