'use strict';
const { spawnSync } = require('node:child_process');

function lookupInstallerRelease(tag, { spawn = spawnSync, cwd = process.cwd() } = {}) {
  function request(args) {
    const result = spawn('gh', ['api', ...args], {
      cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Could not inspect GitHub release ${tag}: ${String(result.stderr || '').trim() || `gh exited ${result.status}`}`);
    }
    try { return JSON.parse(result.stdout); }
    catch { throw new Error(`GitHub release lookup returned invalid JSON for ${tag}.`); }
  }
  // Match gh's draft lookup: REST tag/list endpoints can omit pending drafts
  // with Actions tokens. GraphQL resolves the pending tag to its stable ID.
  const response = request(['graphql', '-f',
    'query=query($tag: String!) { repository(owner: "dbalders", name: "TritonAI-Installer") { release(tagName: $tag) { databaseId } } }',
    '-f', `tag=${tag}`]);
  if (response.errors || !response.data?.repository || !Object.hasOwn(response.data.repository, 'release')) {
    throw new Error('GitHub release lookup returned an invalid GraphQL response.');
  }
  const match = response.data.repository.release;
  if (match === null) return null;
  if (!Number.isSafeInteger(match.databaseId) || match.databaseId <= 0) {
    throw new Error('GitHub release lookup returned an invalid release ID.');
  }
  const release = request([`repos/dbalders/TritonAI-Installer/releases/${match.databaseId}`]);
  if (release.id !== match.databaseId || release.tag_name !== tag) {
    throw new Error('GitHub release lookup returned a mismatched release.');
  }
  return release;
}
module.exports = { lookupInstallerRelease };
