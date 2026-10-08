'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;

function validateInputs(env) {
  if (env.GITHUB_REPOSITORY !== 'dbalders/TritonAI-Installer' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Signing validation is restricted to manual runs on dbalders/TritonAI-Installer main.');
  }
  if (!STABLE_VERSION.test(env.INSTALLER_VERSION || '') || !STABLE_VERSION.test(env.HARNESS_VERSION || '')) {
    throw new Error('Installer and Harness versions must be explicit stable semantic versions.');
  }
  if (!/^[1-9]\d*$/.test(env.HARNESS_RUN_ID || '') || !SHA.test(env.HARNESS_COMMIT || '') || !SHA.test(env.SKILLS_COMMIT || '')) {
    throw new Error('Supply the exact Harness release run ID, Harness commit, and secure-skills commit.');
  }
  const harnessSource = env.HARNESS_SOURCE || 'published';
  if (!['published', 'workflow_artifacts'].includes(harnessSource)) throw new Error('Unknown Harness release source.');
  return { installerVersion: env.INSTALLER_VERSION, harnessVersion: env.HARNESS_VERSION, runId: env.HARNESS_RUN_ID, commit: env.HARNESS_COMMIT, skillsCommit: env.SKILLS_COMMIT, harnessSource };
}

function assertHarnessRun(selection, run, tagCommit) {
  if (run.path !== '.github/workflows/release.yml' || !['push', 'workflow_dispatch'].includes(run.event) || run.head_sha !== selection.commit || run.head_branch !== (run.event === 'push' ? `v${selection.harnessVersion}` : 'main') || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Harness must finish its stable release workflow successfully for the selected tag and exact commit before Installer packaging.');
  }
  if (tagCommit.sha !== selection.commit) throw new Error('Harness tag must resolve to the exact selected source commit.');
}

function assertHarnessRelease(selection, run, release, tagCommit) {
  assertHarnessRun(selection, run, tagCommit);
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== `v${selection.harnessVersion}` || tagCommit.sha !== selection.commit) {
    throw new Error('Harness must have a published stable release whose tag resolves to the selected commit.');
  }
  const names = new Set((release.assets || []).map(asset => asset.name));
  for (const name of ['latest.yml', `TritonAI-Harness-${selection.harnessVersion}-x64.exe`, 'tritonai-plugin-composition-win-x64.json']) {
    if (!names.has(name)) throw new Error(`Harness release is missing ${name}.`);
  }
}

function workflowArtifactReceipt(selection, run, tagCommit, listing) {
  assertHarnessRun(selection, run, tagCommit);
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || !Array.isArray(listing.artifacts) || listing.total_count !== listing.artifacts.length) throw new Error('Harness run attempt or complete artifact metadata is missing.');
  const artifacts = ['desktop-mac-arm64', 'desktop-win-x64'].map(name => {
    const matches = listing.artifacts.filter(artifact => artifact.name === name);
    const artifact = matches[0];
    if (matches.length !== 1 || !Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.workflow_run?.id !== Number(selection.runId) || artifact.workflow_run?.head_sha !== selection.commit) throw new Error(`Harness workflow artifact lacks an immutable exact-run identity: ${name}.`);
    return { name, id: artifact.id, digest: artifact.digest, size: artifact.size_in_bytes };
  });
  return { schemaVersion: 1, selection, runAttempt: run.run_attempt, artifacts };
}

function bindWorkflowReceipt(receipt, receiptPath, requireExisting = false) {
  if (!receiptPath) throw new Error('Workflow Harness source requires a frozen provenance receipt path.');
  if (fs.existsSync(receiptPath)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))) !== JSON.stringify(receipt)) throw new Error('Harness workflow provenance changed since Installer preflight.');
  } else {
    if (requireExisting) throw new Error('Frozen Harness workflow receipt is missing at final verification.');
    fs.mkdirSync(require('node:path').dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  }
}

function main(env = process.env) {
  const selection = validateInputs(env);
  const api = suffix => JSON.parse(execFileSync('gh', ['api', `repos/dbalders/TritonAI-Harness/${suffix}`], { encoding: 'utf8' }));
  const run = api(`actions/runs/${selection.runId}`);
  const tag = api(`commits/v${selection.harnessVersion}`);
  if (selection.harnessSource === 'workflow_artifacts') {
    const receipt = workflowArtifactReceipt(selection, run, tag, api(`actions/runs/${selection.runId}/artifacts?per_page=100`));
    bindWorkflowReceipt(receipt, env.HARNESS_WORKFLOW_RECEIPT, env.HARNESS_WORKFLOW_RECEIPT_REQUIRED === 'true');
  } else {
    assertHarnessRelease(selection, run, api(`releases/tags/v${selection.harnessVersion}`), tag);
  }
  fs.appendFileSync(env.GITHUB_ENV, `TRITONAI_HARNESS_VERSION=${selection.harnessVersion}\nTRITONAI_HARNESS_RELEASE_BASE=https://github.com/dbalders/TritonAI-Harness/releases/download/v${selection.harnessVersion}\n`);
  console.log(`Verified successful Harness run ${selection.runId}, tag v${selection.harnessVersion}, commit ${selection.commit}. Vendoring will verify hashes, plugin composition, publisher and timestamp.`);
}

if (require.main === module) main();
module.exports = { validateInputs, assertHarnessRun, assertHarnessRelease, workflowArtifactReceipt, bindWorkflowReceipt };
