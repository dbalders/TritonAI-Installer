const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

interface AtomicWriteOptions {
  mode?: number;
  preserveExistingMode?: boolean;
}

function writeFileAtomic(
  file: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const existingMode = options.preserveExistingMode && fs.existsSync(file)
    ? fs.statSync(file).mode & 0o777
    : null;
  const mode = existingMode ?? options.mode ?? 0o600;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let descriptor = null;

  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, file);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

function fsyncDirectory(directory: string) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error && error.code)) throw error;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

module.exports = {
  writeFileAtomic
};
