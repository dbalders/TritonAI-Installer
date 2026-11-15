'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isAcceptedReleaseRepository,
  releaseRepository,
  releaseRepositoryOwner
} = require('./release-repository-owner.cjs');
const { lookupInstallerRelease } = require('./github-release-lookup.cjs');
const { wait } = require('./wait-harness-release.cjs');

test('release scripts follow the workflow repository owner across the UCSD transfer', () => {
  assert.equal(releaseRepositoryOwner({}), 'dbalders');
  assert.equal(releaseRepositoryOwner({ GITHUB_REPOSITORY_OWNER: 'dbalders' }), 'dbalders');
  assert.equal(releaseRepositoryOwner({ GITHUB_REPOSITORY_OWNER: 'UCSD' }), 'UCSD');
  assert.equal(releaseRepositoryOwner({ GITHUB_REPOSITORY: 'UCSD/TritonAI-Installer' }), 'UCSD');
  assert.equal(releaseRepositoryOwner({ GITHUB_REPOSITORY_OWNER: 'dbalders', TRITONAI_RELEASE_REPOSITORY_OWNER: 'ucsd' }), 'UCSD');
  assert.equal(releaseRepository('TritonAI-Harness', { GITHUB_REPOSITORY_OWNER: 'UCSD' }), 'UCSD/TritonAI-Harness');
  for (const owner of ['someone', 'UCSD-evil', 'ucsd-forks']) {
    assert.throws(() => releaseRepositoryOwner({ GITHUB_REPOSITORY_OWNER: owner }), /not accepted/, owner);
  }
});

test('only the exact named repository under either owner is accepted', () => {
  assert.equal(isAcceptedReleaseRepository('dbalders/TritonAI-Installer', 'TritonAI-Installer'), true);
  assert.equal(isAcceptedReleaseRepository('UCSD/TritonAI-Installer', 'TritonAI-Installer'), true);
  for (const repository of ['someone/TritonAI-Installer', 'UCSD/TritonAI-Harness', 'UCSD/TritonAI-Installer-fork', undefined]) {
    assert.equal(isAcceptedReleaseRepository(repository, 'TritonAI-Installer'), false, String(repository));
  }
});

test('the draft release lookup addresses the Installer under the current owner', () => {
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    if (args[1] === 'graphql') {
      return { status: 0, stdout: JSON.stringify({ data: { repository: { release: { databaseId: 7 } } } }), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify({ id: 7, tag_name: 'v0.4.3' }), stderr: '' };
  };
  assert.equal(lookupInstallerRelease('v0.4.3', { spawn, env: { GITHUB_REPOSITORY_OWNER: 'UCSD' } }).id, 7);
  assert.ok(calls[0].includes('owner=UCSD'));
  assert.ok(calls[0].some(argument => argument.includes('repository(owner: $owner')));
  assert.deepEqual(calls[1], ['api', 'repos/UCSD/TritonAI-Installer/releases/7']);
});

test('the Harness CI wait reads the Harness repository under the current owner', () => {
  const commit = 'a'.repeat(40);
  const calls = [];
  const gh = (...args) => {
    calls.push(args);
    if (args[0] === 'run') return '';
    return JSON.stringify({ head_sha: commit, path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success' });
  };
  wait('123', commit, gh, { GITHUB_REPOSITORY_OWNER: 'UCSD' });
  assert.deepEqual(calls[0], ['api', 'repos/UCSD/TritonAI-Harness/actions/runs/123']);
  assert.deepEqual(calls[1].slice(0, 4), ['run', 'watch', '123', '--repo']);
  assert.equal(calls[1][4], 'UCSD/TritonAI-Harness');
});
