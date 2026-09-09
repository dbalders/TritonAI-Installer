#!/usr/bin/env node
const { execFileSync, spawnSync } = require('node:child_process');
function github(...args) {
  if (args[0] !== 'run') return execFileSync('gh', args, { encoding: 'utf8' });
  const result = spawnSync('gh', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Harness CI wait failed: ${result.status ?? result.signal}`);
  return '';
}
function wait(runId, commit, gh = github) {
  if (!/^\d+$/.test(runId || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Expected an exact Harness run ID and commit');
  const args = ['--repo', 'dbalders/TritonAI-Harness'];
  const view = () => JSON.parse(gh('api', `repos/dbalders/TritonAI-Harness/actions/runs/${runId}`));
  const before = view();
  if (before.head_sha !== commit || before.path !== '.github/workflows/release.yml') throw new Error('Harness run does not match the release workflow and selected commit');
  // gh handles polling in one process. No AI loop is needed.
  gh('run', 'watch', runId, ...args, '--exit-status', '--interval', '30');
  const after = view();
  if (after.head_sha !== commit || after.status !== 'completed' || after.conclusion !== 'success') throw new Error('Harness release run did not complete successfully');
}
if (require.main === module) {
  try { wait(process.argv[2], process.argv[3]); console.log('Harness CI passed for the selected commit.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { wait };
