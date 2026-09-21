import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { APPROVED_CODEX_VERSION } from "../src/installer/approved-codex-policy";

export function verifyPackagedCodexPolicy(resources: string, archiveName: "app.asar" | "server.asar", asar?: { extractFile: (archive: string, file: string) => Buffer }) {
  const reader = asar ?? createRequire(require.resolve("app-builder-lib/package.json"))("@electron/asar");
  const source = reader.extractFile(path.join(resources, archiveName), "apps/server/dist/tritonai-managed-config.json");
  const policy = JSON.parse(source.toString("utf8"));
  if (policy?.schemaVersion !== 2 || policy?.provider?.approvedCodexVersion !== APPROVED_CODEX_VERSION) {
    throw new Error("Packaged Harness approved Codex version differs from the Installer snapshot. Sync policy from the selected Harness release before packaging.");
  }
}

if (require.main === module) {
  const [artifact, version] = process.argv.slice(2);
  if (!artifact || !version) throw new Error("Expected a Windows Harness artifact and version.");
  const root = path.resolve(__dirname, "../..");
  const { verifyWindowsHarness } = require(path.join(root, "scripts/local-release-payload.cjs"));
  verifyWindowsHarness({
    artifact, version, outputDirectory: path.dirname(artifact), installerRoot: root,
    composition: JSON.parse(fs.readFileSync(path.join(path.dirname(artifact), "tritonai-plugin-composition.json"), "utf8")),
    verifyResources: (resources, asar) => verifyPackagedCodexPolicy(resources, "server.asar", asar),
  }).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
