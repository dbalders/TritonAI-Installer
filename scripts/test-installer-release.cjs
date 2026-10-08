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



test('workflow source verifies ZIP extraction and uses authenticated local files', { skip: !['darwin', 'win32'].includes(process.platform) }, t => {
  const { createHash } = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const { downloadArtifact, sha256 } = require('./download-harness-workflow-artifact.cjs');
  const { validateInputs } = require('./validate-windows-signing-inputs.cjs');
  const { readHarnessSourceEnvironment, downloadVerified } = require('../dist/scripts/prepare-t3code-desktop-vendor.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow harness input '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceEnv = { GITHUB_REPOSITORY: 'dbalders/TritonAI-Installer', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', INSTALLER_VERSION: '0.3.6', HARNESS_VERSION: '0.3.6', HARNESS_RUN_ID: '1234', HARNESS_COMMIT: 'a'.repeat(40), SKILLS_COMMIT: 'b'.repeat(40), HARNESS_SOURCE: 'workflow_artifacts', TRITONAI_HARNESS_VERSION: '0.3.6', TRITONAI_HARNESS_RUN_ARTIFACT_DIR: path.join(root, 'run'), HARNESS_WORKFLOW_RECEIPT: path.join(root, 'receipt.json'), HARNESS_ARTIFACT_NAME: 'desktop-mac-arm64', TRITONAI_HARNESS_RELEASE_BASE: 'https://example.com/must-not-fetch', TRITONAI_HARNESS_MAC_RELEASE_BASE: 'https://example.com/must-not-fetch' };
  const payload = Buffer.from('immutable workflow fixture');
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'latest-mac.yml'), payload);
  const archive = path.join(root, 'fixture.zip');
  if (process.platform === 'win32') execFileSync('tar.exe', ['-a', '-cf', archive, '-C', fixture, 'latest-mac.yml']);
  else if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-c', '-k', fixture, archive]);
  const artifact = { name: 'desktop-mac-arm64', id: 99, size: fs.statSync(archive).size, digest: `sha256:${sha256(archive)}` };
  const receipt = { schemaVersion: 1, selection: validateInputs(sourceEnv), runAttempt: 2, artifacts: [artifact] };
  fs.writeFileSync(sourceEnv.HARNESS_WORKFLOW_RECEIPT, JSON.stringify(receipt));
  const fetchZip = (id, destination) => { assert.equal(id, artifact.id); fs.copyFileSync(archive, destination); };
  downloadArtifact(sourceEnv, { fetchZip });
  assert.deepEqual(fs.readFileSync(path.join(sourceEnv.TRITONAI_HARNESS_RUN_ARTIFACT_DIR, 'latest-mac.yml')), payload);
  const source = readHarnessSourceEnvironment(sourceEnv);
  assert.equal(source.macReleaseBase, pathToFileURL(sourceEnv.TRITONAI_HARNESS_RUN_ARTIFACT_DIR).href);
  assert.equal(source.winReleaseBase, source.macReleaseBase);
  const staged = path.join(root, 'staged-manifest');
  downloadVerified(`${source.defaultReleaseBase}/latest-mac.yml`, staged, { size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') });
  assert.deepEqual(fs.readFileSync(staged), payload);
  assert.throws(() => readHarnessSourceEnvironment({ ...sourceEnv, TRITONAI_HARNESS_RUN_ARTIFACT_DIR: '' }), /requires authenticated/);
  assert.throws(() => downloadArtifact(sourceEnv, { fetchZip }), /must be absent/);
});


test('workflow receipt and ZIP size/digest rejection precede extraction on every host', t => {
  const { createHash } = require('node:crypto');
  const { downloadArtifact } = require('./download-harness-workflow-artifact.cjs');
  const { validateInputs } = require('./validate-windows-signing-inputs.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-zip-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { GITHUB_REPOSITORY: 'dbalders/TritonAI-Installer', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', INSTALLER_VERSION: '0.3.6', HARNESS_VERSION: '0.3.6', HARNESS_RUN_ID: '1234', HARNESS_COMMIT: 'a'.repeat(40), SKILLS_COMMIT: 'b'.repeat(40), HARNESS_SOURCE: 'workflow_artifacts', TRITONAI_HARNESS_RUN_ARTIFACT_DIR: path.join(root, 'run'), HARNESS_WORKFLOW_RECEIPT: path.join(root, 'receipt.json'), HARNESS_ARTIFACT_NAME: 'desktop-mac-arm64' };
  // Deliberately invalid ZIP bytes: integrity failures must precede any native tool.
  const bytes = Buffer.from('immutable archive integrity fixture');
  const artifact = { name: env.HARNESS_ARTIFACT_NAME, id: 99, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const receipt = { schemaVersion: 1, selection: validateInputs(env), runAttempt: 2, artifacts: [artifact] };
  const fetchZip = (id, destination) => { assert.equal(id, artifact.id); fs.writeFileSync(destination, bytes); };
  for (const delta of [{ size: bytes.length + 1 }, { digest: `sha256:${'0'.repeat(64)}` }]) {
    fs.writeFileSync(env.HARNESS_WORKFLOW_RECEIPT, JSON.stringify({ ...receipt, artifacts: [{ ...artifact, ...delta }] }));
    assert.throws(() => downloadArtifact(env, { fetchZip }), /differs from the frozen successful-run digest/);
    assert.ok(!fs.existsSync(env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR));
  }
  fs.writeFileSync(env.HARNESS_WORKFLOW_RECEIPT, JSON.stringify(receipt));
  assert.throws(() => downloadArtifact({ ...env, HARNESS_RUN_ID: '1235' }, { fetchZip }), /does not match the exact selected source/);
  assert.ok(!fs.existsSync(env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR));
  assert.deepEqual(fs.readdirSync(root), ['receipt.json']);
});
