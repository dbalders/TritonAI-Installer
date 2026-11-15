'use strict';

// The release repositories (Installer, Harness, and secure skills) are moving together from
// dbalders to the UCSD organization. Release scripts derive the owner from the workflow that
// runs them so they keep working on either side of the transfer. Local runs default to the
// current owner and can set TRITONAI_RELEASE_REPOSITORY_OWNER explicitly.
const ACCEPTED_RELEASE_REPOSITORY_OWNERS = Object.freeze(['dbalders', 'UCSD']);
const DEFAULT_RELEASE_REPOSITORY_OWNER = 'dbalders';

function releaseRepositoryOwner(env = process.env) {
  const requested = env.TRITONAI_RELEASE_REPOSITORY_OWNER
    || env.GITHUB_REPOSITORY_OWNER
    || String(env.GITHUB_REPOSITORY || '').split('/')[0]
    || DEFAULT_RELEASE_REPOSITORY_OWNER;
  const owner = ACCEPTED_RELEASE_REPOSITORY_OWNERS.find(candidate => candidate.toLowerCase() === requested.toLowerCase());
  if (!owner) {
    throw new Error(`Release repositories must be owned by ${ACCEPTED_RELEASE_REPOSITORY_OWNERS.join(' or ')}; ${requested} is not accepted.`);
  }
  return owner;
}

function releaseRepository(name, env = process.env) {
  return `${releaseRepositoryOwner(env)}/${name}`;
}

function isAcceptedReleaseRepository(repository, name) {
  return ACCEPTED_RELEASE_REPOSITORY_OWNERS.some(owner => repository === `${owner}/${name}`);
}

module.exports = {
  ACCEPTED_RELEASE_REPOSITORY_OWNERS,
  DEFAULT_RELEASE_REPOSITORY_OWNER,
  isAcceptedReleaseRepository,
  releaseRepository,
  releaseRepositoryOwner
};
