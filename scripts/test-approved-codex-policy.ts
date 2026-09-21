import * as assert from "node:assert/strict";
import { renderApprovedCodexPolicy } from "./sync-approved-codex-policy";
const commit = "a".repeat(40);
const config = (version: unknown) => ({ schemaVersion: 2, policyVersion: 6, provider: { approvedCodexVersion: version } });
assert.match(renderApprovedCodexPolicy(config("0.151.0"), commit), /APPROVED_CODEX_VERSION = "0.151.0"/);
assert.match(renderApprovedCodexPolicy(config("0.152.0"), commit), /APPROVED_CODEX_VERSION = "0.152.0"/);
for (const version of [undefined, null, "latest", "^0.151.0", "0.151.0;echo unsafe", "01.151.0"]) {
  assert.throws(() => renderApprovedCodexPolicy(config(version), commit));
}
assert.throws(() => renderApprovedCodexPolicy(config("0.151.0"), "main"));
const { CODEX_CLI_VERSION } = require("../src/installer/npm-policy");
const { APPROVED_CODEX_VERSION } = require("../src/installer/approved-codex-policy");
assert.equal(CODEX_CLI_VERSION, APPROVED_CODEX_VERSION);
console.log("Approved Codex policy tests passed.");

async function testPackagedPolicy() {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const { createRequire } = require("node:module");
  const asar = createRequire(require.resolve("app-builder-lib/package.json"))("@electron/asar");
  const { verifyPackagedCodexPolicy } = require("./verify-packaged-codex-policy");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-codex-policy-"));
  try {
    for (const archiveName of ["app.asar", "server.asar"]) {
      for (const approvedCodexVersion of ["0.151.0", "0.155.1", undefined, "latest"]) {
        const sourceRoot = fs.mkdtempSync(path.join(temp, "source-"));
        const target = path.join(sourceRoot, "apps/server/dist/tritonai-managed-config.json");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify({ schemaVersion: 2, provider: { approvedCodexVersion } }));
        const resources = fs.mkdtempSync(path.join(temp, "resources-"));
        await asar.createPackage(sourceRoot, path.join(resources, archiveName));
        if (approvedCodexVersion === APPROVED_CODEX_VERSION) verifyPackagedCodexPolicy(resources, archiveName);
        else assert.throws(() => verifyPackagedCodexPolicy(resources, archiveName), /differs/);
      }
    }
    console.log("Packaged Harness policy binding tests passed.");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
void testPackagedPolicy().catch((error) => { console.error(error); process.exitCode = 1; });
