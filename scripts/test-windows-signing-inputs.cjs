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

test('workflow source binds exact successful run attempt and both immutable artifact identities', () => {
  const { workflowArtifactReceipt } = require('./validate-windows-signing-inputs.cjs');
  const source = validateInputs({ ...env, HARNESS_SOURCE: 'workflow_artifacts' });
  const completeRun = { ...run, run_attempt: 2 };
  const artifacts = ['desktop-mac-arm64', 'desktop-win-x64'].map((name, index) => ({ name, id: index + 1, expired: false, size_in_bytes: 100, digest: `sha256:${'c'.repeat(64)}`, workflow_run: { id: Number(source.runId), head_sha: source.commit } }));
  const listing = { total_count: artifacts.length, artifacts };
  assert.equal(workflowArtifactReceipt(source, completeRun, tag, listing).runAttempt, 2);
  for (const delta of [{ expired: true }, { id: 0 }, { size_in_bytes: 0 }, { digest: null }, { workflow_run: { id: 1235, head_sha: source.commit } }, { workflow_run: { id: Number(source.runId), head_sha: 'd'.repeat(40) } }]) {
    assert.throws(() => workflowArtifactReceipt(source, completeRun, tag, { ...listing, artifacts: [{ ...artifacts[0], ...delta }, artifacts[1]] }));
  }
  assert.throws(() => workflowArtifactReceipt(source, { ...completeRun, run_attempt: 0 }, tag, listing));
  assert.throws(() => workflowArtifactReceipt(source, completeRun, tag, { ...listing, total_count: 101 }));
  assert.throws(() => workflowArtifactReceipt(source, completeRun, tag, { total_count: 1, artifacts: artifacts.slice(0, 1) }));
  assert.throws(() => validateInputs({ ...env, HARNESS_SOURCE: 'draft_artifacts' }));
});

test('final provenance recheck rejects a changed run attempt, archive or missing frozen receipt', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { bindWorkflowReceipt } = require('./validate-windows-signing-inputs.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-workflow-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, 'receipt.json');
  const receipt = { schemaVersion: 1, selection, runAttempt: 2, artifacts: [{ id: 1, digest: 'original' }] };
  assert.throws(() => bindWorkflowReceipt(receipt, receiptPath, true), /receipt is missing/);
  bindWorkflowReceipt(receipt, receiptPath);
  assert.doesNotThrow(() => bindWorkflowReceipt(receipt, receiptPath, true));
  assert.throws(() => bindWorkflowReceipt({ ...receipt, runAttempt: 3 }, receiptPath, true), /provenance changed/);
  assert.throws(() => bindWorkflowReceipt({ ...receipt, artifacts: [{ id: 2, digest: 'replacement' }] }, receiptPath, true), /provenance changed/);
});
