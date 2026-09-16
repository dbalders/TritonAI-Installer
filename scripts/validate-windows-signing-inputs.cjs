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
  return { installerVersion: env.INSTALLER_VERSION, harnessVersion: env.HARNESS_VERSION, runId: env.HARNESS_RUN_ID, commit: env.HARNESS_COMMIT, skillsCommit: env.SKILLS_COMMIT };
}

function assertHarnessRelease(selection, run, release, tagCommit) {
  if (run.path !== '.github/workflows/release.yml' || run.event !== 'push' || run.head_sha !== selection.commit || run.head_branch !== `v${selection.harnessVersion}` || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Harness must finish its stable release workflow successfully for the selected tag and exact commit before Installer packaging.');
  }
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== `v${selection.harnessVersion}` || tagCommit.sha !== selection.commit) {
    throw new Error('Harness must have a published stable release whose tag resolves to the selected commit.');
  }
  const names = new Set((release.assets || []).map(asset => asset.name));
  for (const name of ['latest.yml', `TritonAI-Harness-${selection.harnessVersion}-x64.exe`, 'tritonai-plugin-composition-win-x64.json']) {
    if (!names.has(name)) throw new Error(`Harness release is missing ${name}.`);
  }
}

function main(env = process.env) {
  const selection = validateInputs(env);
  const api = suffix => JSON.parse(execFileSync('gh', ['api', `repos/dbalders/TritonAI-Harness/${suffix}`], { encoding: 'utf8' }));
  assertHarnessRelease(selection, api(`actions/runs/${selection.runId}`), api(`releases/tags/v${selection.harnessVersion}`), api(`commits/v${selection.harnessVersion}`));
  fs.appendFileSync(env.GITHUB_ENV, `TRITONAI_HARNESS_VERSION=${selection.harnessVersion}\nTRITONAI_HARNESS_RELEASE_BASE=https://github.com/dbalders/TritonAI-Harness/releases/download/v${selection.harnessVersion}\n`);
  console.log(`Verified successful Harness run ${selection.runId}, tag v${selection.harnessVersion}, commit ${selection.commit}. Vendoring will verify hashes, plugin composition, publisher and timestamp.`);
}

if (require.main === module) main();
module.exports = { validateInputs, assertHarnessRelease };
