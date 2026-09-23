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

test('downloads stage on the destination volume and preserve existing bytes on digest failure', () => {
  const { downloadManifest, downloadVerified } = require('../dist/scripts/prepare-t3code-desktop-vendor.js');
  const { pathToFileURL } = require('node:url');
  const { createHash } = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-download-'));
  const rename = fs.renameSync;
  try {
    const destination = path.join(root, 'other-volume');
    fs.mkdirSync(destination);
    const source = path.join(root, 'source');
    const bytes = Buffer.from('verified release bytes');
    fs.writeFileSync(source, bytes);
    const target = path.join(destination, 'artifact');
    fs.renameSync = (from, to) => {
      if (path.dirname(from) !== path.dirname(to)) {
        throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
      }
      return rename(from, to);
    };
    downloadManifest(pathToFileURL(source).href, target);
    assert.deepEqual(fs.readFileSync(target), bytes);
    fs.writeFileSync(target, 'previous candidate');
    const expected = { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') };
    assert.throws(() => downloadVerified(pathToFileURL(source).href, target, { ...expected, sha512: 'invalid' }), /SHA-512 mismatch/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous candidate');
    downloadVerified(pathToFileURL(source).href, target, expected);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.deepEqual(fs.readdirSync(destination), ['artifact']);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
