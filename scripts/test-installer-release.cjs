'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertInstallerSource } = require('./installer-release-preflight.cjs');
const { verifyHarnessRunArtifacts } = require('../dist/scripts/verify-harness-run-artifacts.js');
test('release preflight rejects version drift, existing releases and conflicting tags', () => {
  const sha = 'a'.repeat(40);
  assert.doesNotThrow(() => assertInstallerSource('0.3.4', { version: '0.3.4' }, null, { sha }, sha));
  assert.doesNotThrow(() => assertInstallerSource('0.3.4', { version: '0.3.4' }, null, null, sha));
  assert.throws(() => assertInstallerSource('0.3.4', { version: '0.3.3' }, null, null, sha));
  for (const draft of [true, false]) assert.throws(() => assertInstallerSource('0.3.4', { version: '0.3.4' }, { draft }, null, sha));
  assert.throws(() => assertInstallerSource('0.3.4', { version: '0.3.4' }, null, { sha: 'b'.repeat(40) }, sha));
});
for (const platform of ['mac', 'win']) test(`${platform} payload binding rejects a different successful run's bytes`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-binding-'));
  try {
    const run = path.join(root, 'run'), staged = path.join(root, 'staged');
    fs.mkdirSync(run); fs.mkdirSync(staged);
    const names = platform === 'mac' ? ['latest-mac.yml', 'TritonAI-Harness-0.3.4-arm64.dmg', 'tritonai-plugin-composition-mac-arm64.json'] : ['latest.yml', 'TritonAI-Harness-0.3.4-x64.exe', 'tritonai-plugin-composition-win-x64.json'];
    for (const name of names) {
      fs.writeFileSync(path.join(run, name), name);
      fs.writeFileSync(path.join(staged, name.startsWith('tritonai-plugin') ? 'tritonai-plugin-composition.json' : name), name);
    }
    assert.equal(verifyHarnessRunArtifacts(run, staged, '0.3.4', platform).length, 3);
    fs.appendFileSync(path.join(staged, names[1]), 'tampered');
    assert.throws(() => verifyHarnessRunArtifacts(run, staged, '0.3.4', platform));
    fs.unlinkSync(path.join(staged, names[1]));
    assert.throws(() => verifyHarnessRunArtifacts(run, staged, '0.3.4', platform));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
