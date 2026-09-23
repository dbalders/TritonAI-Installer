'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateInputs, assertHarnessRelease } = require('./validate-windows-signing-inputs.cjs');
const env = { GITHUB_REPOSITORY: 'dbalders/TritonAI-Installer', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', INSTALLER_VERSION: '0.3.4', HARNESS_VERSION: '0.3.4', HARNESS_RUN_ID: '1234', HARNESS_COMMIT: 'a'.repeat(40), SKILLS_COMMIT: 'b'.repeat(40) };
const selection = validateInputs(env);
const run = { path: '.github/workflows/release.yml', event: 'push', head_sha: selection.commit, head_branch: 'v0.3.4', status: 'completed', conclusion: 'success' };
const release = { draft: false, prerelease: false, tag_name: 'v0.3.4', assets: ['latest.yml', 'TritonAI-Harness-0.3.4-x64.exe', 'tritonai-plugin-composition-win-x64.json'].map(name => ({ name })) };
const tag = { sha: selection.commit };
test('only manual canonical main can request stable signing validation', () => {
  assert.equal(selection.installerVersion, '0.3.4');
  for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'someone/fork', GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request_target', INSTALLER_VERSION: '01.2.3', HARNESS_VERSION: '0.3.4-nightly.1', HARNESS_RUN_ID: '1\ninjected', HARNESS_COMMIT: 'main', SKILLS_COMMIT: 'main' })) {
    assert.throws(() => validateInputs({ ...env, [key]: value }), undefined, key);
  }
});
test('requires successful exact stable Harness run and matching published tag', () => {
  assert.doesNotThrow(() => assertHarnessRelease(selection, run, release, tag));
  for (const delta of [{ conclusion: 'failure' }, { status: 'in_progress' }, { head_sha: 'c'.repeat(40) }, { head_branch: 'main' }, { path: '.github/workflows/nightly.yml' }, { event: 'pull_request' }]) {
    assert.throws(() => assertHarnessRelease(selection, { ...run, ...delta }, release, tag));
  }
  for (const delta of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.3.3' }, { assets: release.assets.slice(0, 2) }]) {
    assert.throws(() => assertHarnessRelease(selection, run, { ...release, ...delta }, tag));
  }
  assert.throws(() => assertHarnessRelease(selection, run, release, { sha: 'c'.repeat(40) }));
});

test('accepts controlled manual stable releases only at the published tag commit', () => {
  const manual = { ...run, event: 'workflow_dispatch', head_branch: 'main' };
  assert.doesNotThrow(() => assertHarnessRelease(selection, manual, release, tag));
  assert.throws(() => assertHarnessRelease(selection, { ...manual, head_sha: 'd'.repeat(40) }, release, tag));
  assert.throws(() => assertHarnessRelease(selection, { ...manual, head_branch: 'feature' }, release, tag));
});
