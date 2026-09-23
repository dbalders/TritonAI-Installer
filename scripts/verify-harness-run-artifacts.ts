import * as fs from "node:fs";
import * as path from "node:path";
import { fileDigest } from "../src/installer/file-digest";

// The run artifact is downloaded by ID from the selected successful Harness run,
// independently of the mutable release. Compare every consumed release input.
export function verifyHarnessRunArtifacts(runDirectory: string, stagedDirectory: string, version: string, platform: "win" | "mac" = "win") {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable Harness version for run binding.");
  const files = platform === "mac" ? [
    ["latest-mac.yml", "latest-mac.yml"],
    [`TritonAI-Harness-${version}-arm64.dmg`, `TritonAI-Harness-${version}-arm64.dmg`],
    ["tritonai-plugin-composition-mac-arm64.json", "tritonai-plugin-composition.json"]
  ] : [
    ["latest.yml", "latest.yml"],
    [`TritonAI-Harness-${version}-x64.exe`, `TritonAI-Harness-${version}-x64.exe`],
    ["tritonai-plugin-composition-win-x64.json", "tritonai-plugin-composition.json"]
  ];
  return files.map(([runName, stagedName]) => {
    const expected = path.join(runDirectory, runName);
    const actual = path.join(stagedDirectory, stagedName);
    for (const file of [expected, actual]) {
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) {
        throw new Error(`Missing regular Harness run-binding input: ${file}`);
      }
    }
    const sha512 = fileDigest(expected, "sha512", "base64");
    const size = fs.statSync(expected).size;
    if (fs.statSync(actual).size !== size || fileDigest(actual, "sha512", "base64") !== sha512) {
      throw new Error(`Harness release ${runName} differs from the selected successful run artifact.`);
    }
    return { fileName: runName, size, sha512 };
  });
}
