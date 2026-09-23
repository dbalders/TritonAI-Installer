'use strict';
const { execFileSync } = require('node:child_process');
const { validateInputs } = require('./validate-windows-signing-inputs.cjs');

function assertInstallerSource(version, pkg, release, tag, head) {
  if (pkg.version !== version) throw new Error('Installer version must match committed package.json.');
  if (release) throw new Error('Installer release already exists; inspect it before starting another build.');
  if (tag && tag.sha !== head) throw new Error('Installer tag points to a different source commit.');
}
function lookup(suffix) {
  try {
    return JSON.parse(execFileSync('gh', ['api', `repos/dbalders/TritonAI-Installer/${suffix}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    if (/\bHTTP 404\b/.test(String(error.stderr))) return null;
    throw new Error(`Cannot verify Installer ${suffix}; GitHub lookup failed.`);
  }
}
function main() {
  const { installerVersion } = validateInputs(process.env);
  assertInstallerSource(installerVersion, require('../package.json'), lookup(`releases/tags/v${installerVersion}`), lookup(`commits/v${installerVersion}`), process.env.GITHUB_SHA);
  console.log(`Verified Installer ${installerVersion} source and unused release target.`);
}
if (require.main === module) main();
module.exports = { assertInstallerSource };
