const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getPaths } = require("../src/installer/paths");
const {
  INSTALLER_VERSION_MARKER_FILENAME,
  normalizeInstallerVersion,
  writeInstallerVersionMarker
} = require("../src/installer/installer-version-marker");

function main() {
  assert.strictEqual(normalizeInstallerVersion("v1.2.3"), "1.2.3");
  assert.strictEqual(normalizeInstallerVersion("1.2.3-beta.1"), null);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-installer-marker-"));
  try {
    const paths = getPaths(tempRoot, process.platform);
    const result = writeInstallerVersionMarker({
      paths,
      installerVersion: "v1.2.3",
      now: () => new Date("2026-07-09T12:34:56.000Z")
    });

    assert.strictEqual(result.markerPath, paths.installerVersionMarker);
    assert.strictEqual(path.basename(result.markerPath), INSTALLER_VERSION_MARKER_FILENAME);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(paths.installerVersionMarker, "utf8")),
      {
        schemaVersion: 1,
        version: "1.2.3",
        installedAt: "2026-07-09T12:34:56.000Z"
      }
    );
    assert.deepStrictEqual(
      fs.readdirSync(paths.stateDir).filter((name) => name.endsWith(".tmp")),
      [],
      "atomic writes must not leave a temporary file behind"
    );

    writeInstallerVersionMarker({ paths, installerVersion: "1.2.4" });
    assert.strictEqual(
      JSON.parse(fs.readFileSync(paths.installerVersionMarker, "utf8")).version,
      "1.2.4",
      "a later successful install should atomically replace the marker"
    );
    assert.throws(
      () => writeInstallerVersionMarker({ paths, installerVersion: "preview" }),
      /installer version is invalid/
    );
    assert.strictEqual(
      JSON.parse(fs.readFileSync(paths.installerVersionMarker, "utf8")).version,
      "1.2.4",
      "a rejected write must preserve the last valid marker"
    );
    assert.deepStrictEqual(
      fs.readdirSync(paths.stateDir).filter((name) => name.endsWith(".tmp")),
      [],
      "a rejected write must not leave temporary files"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("Installer version marker tests passed.");
}

main();
