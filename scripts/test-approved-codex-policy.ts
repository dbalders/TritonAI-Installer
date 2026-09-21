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
