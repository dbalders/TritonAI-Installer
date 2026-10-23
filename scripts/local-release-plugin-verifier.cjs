// Local verification tools are separate from the remotely approved plugin payload.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function validatePluginVerificationTool(input) {
  if (input === undefined) return undefined;
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).sort().join(',') !== 'commit,repo'
    || typeof input.repo !== 'string' || !path.isAbsolute(input.repo)
    || !/^[a-f0-9]{40}$/.test(input.commit || '')) throw new Error('pluginVerificationTool requires an absolute repo and full commit SHA.');
  const repo = fs.realpathSync(input.repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (fs.realpathSync(git('rev-parse', '--show-toplevel')) !== repo || git('rev-parse', 'HEAD') !== input.commit) throw new Error('Plugin verification tool must be at its exact frozen commit.');
  if (git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Plugin verification tool must be clean.');
  return { repo, commit: input.commit };
}

function verifyPluginVerificationParity(candidate, prepared, root) {
  const tool = validatePluginVerificationTool({ repo: prepared.dirs['plugins-verifier'], commit: candidate.pluginVerificationTool.commit });
  const payload = JSON.parse(fs.readFileSync(path.join(prepared.pluginInput, 'manifest.json'), 'utf8'));
  assert.deepEqual(payload.packages.map(p => p.id).sort(), [...candidate.pluginIds].sort(), 'Frozen plugin package selection differs.');
  assert.equal(payload.source.commit, candidate.sources.plugins.commit, 'Frozen plugin payload source differs.');
  // Composition and its byte inventory belong to the exact frozen Harness.
  const producerIdentity = validatePluginVerificationTool({ repo: prepared.dirs['harness-mac'], commit: prepared.commits.harness });
  const producer = require(path.join(producerIdentity.repo, '.github/scripts/prepare-managed-plugins.cjs'));
  const parent = path.join(root, 'proof');
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, '.plugin-verifier-parity-'));
  try {
    // Diagnostic snapshot only; never replace the remote-verified production input.
    const snapshot = producer.stagePluginsFromSource({ sourceRoot: tool.repo,
      vendorDir: path.join(scratch, 'snapshot'), selectedIds: candidate.pluginIds,
      source: { repository: payload.source.repository, ref: tool.commit, commit: tool.commit } });
    const ordered = packages => [...packages].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(ordered(snapshot.packages), ordered(payload.packages), 'Plugin verification tool payload differs from the frozen production composition.');
    return { checkedAt: new Date().toISOString(), payloadSource: payload.source,
      verificationTool: tool, packages: snapshot.packages.map(({ id, version, digest, files }) => ({ id, version, digest, files: files.length })) };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

module.exports = { validatePluginVerificationTool, verifyPluginVerificationParity };
