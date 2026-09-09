import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

// Release artifacts can exceed Buffer's size limit. Keep verification memory independent of size.
export function fileDigest(file: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): string {
  const hash = createHash(algorithm);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, "r");
  try {
    let length: number;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest(encoding);
  } finally {
    closeSync(descriptor);
  }
}
