const fs = require("fs");
const path = require("path");

const INSTALLER_VERSION_MARKER_FILENAME = "installer-version.json";
const MARKER_SCHEMA_VERSION = 1;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function normalizeInstallerVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  return STABLE_VERSION_PATTERN.test(normalized) ? normalized : null;
}

function writeInstallerVersionMarker({ paths, installerVersion, now = () => new Date() }) {
  const version = normalizeInstallerVersion(installerVersion);
  if (!version) {
    throw new Error("The installer version is invalid; the installation version marker was not written.");
  }

  const markerPath = paths && paths.installerVersionMarker;
  if (typeof markerPath !== "string" || markerPath.length === 0) {
    throw new Error("The installer version marker path is unavailable.");
  }

  const markerDirectory = path.dirname(markerPath);
  fs.mkdirSync(markerDirectory, { recursive: true });

  const marker = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    version,
    installedAt: now().toISOString()
  };
  const temporaryPath = path.join(
    markerDirectory,
    `.${path.basename(markerPath)}.${process.pid}.${Date.now()}.tmp`
  );

  let fileDescriptor = null;
  try {
    fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(marker)}\n`, "utf8");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.renameSync(temporaryPath, markerPath);
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {}
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }

  return { markerPath, marker };
}

module.exports = {
  INSTALLER_VERSION_MARKER_FILENAME,
  MARKER_SCHEMA_VERSION,
  normalizeInstallerVersion,
  writeInstallerVersionMarker
};
