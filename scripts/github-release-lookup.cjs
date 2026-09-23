'use strict';
const { spawnSync } = require('node:child_process');

function lookupInstallerRelease(tag, { spawn = spawnSync, cwd = process.cwd() } = {}) {
  // The tag endpoint excludes drafts. The authenticated list includes them.
  const result = spawn('gh', ['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json',
    'repos/dbalders/TritonAI-Installer/releases?per_page=100'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect GitHub release ${tag}: ${String(result.stderr || '').trim() || `gh exited ${result.status}`}`);
  }
  let pages;
  try { pages = JSON.parse(result.stdout); }
  catch { throw new Error(`GitHub release lookup returned invalid JSON for ${tag}.`); }
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
    throw new Error('GitHub release lookup returned an invalid paginated list.');
  }
  const matches = pages.flat().filter(release => release?.tag_name === tag);
  if (matches.length > 1) throw new Error(`Multiple GitHub releases match ${tag}; inspect them before proceeding.`);
  return matches[0] || null;
}
module.exports = { lookupInstallerRelease };
