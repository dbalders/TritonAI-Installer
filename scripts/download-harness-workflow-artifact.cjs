'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { validateInputs } = require('./validate-windows-signing-inputs.cjs');

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function downloadZip(artifactId, destination) {
  const fd = fs.openSync(destination, 'wx');
  try {
    // gh follows the signed download redirect without logging credentials/URLs.
    const result = spawnSync('gh', ['api', `repos/dbalders/TritonAI-Harness/actions/artifacts/${artifactId}/zip`], { stdio: ['ignore', fd, 'pipe'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Harness artifact download failed: ${String(result.stderr || '').trim()}`);
  } finally { fs.closeSync(fd); }
}

function downloadArtifact(env = process.env, { fetchZip = downloadZip } = {}) {
  const selection = validateInputs(env);
  if (selection.harnessSource !== 'workflow_artifacts') throw new Error('Exact artifact downloading requires workflow_artifacts source.');
  if (!env.HARNESS_WORKFLOW_RECEIPT || !env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR) throw new Error('Harness workflow receipt and artifact destination are required.');
  const receipt = JSON.parse(fs.readFileSync(env.HARNESS_WORKFLOW_RECEIPT, 'utf8'));
  if (receipt.schemaVersion !== 1 || JSON.stringify(receipt.selection) !== JSON.stringify(selection) || !Number.isSafeInteger(receipt.runAttempt) || receipt.runAttempt < 1 || !Array.isArray(receipt.artifacts)) throw new Error('Harness artifact receipt does not match the exact selected source.');
  const name = env.HARNESS_ARTIFACT_NAME;
  if (!['desktop-mac-arm64', 'desktop-win-x64'].includes(name)) throw new Error('Select an explicit Harness desktop platform artifact.');
  const matches = receipt.artifacts.filter(artifact => artifact.name === name);
  const artifact = matches[0];
  if (matches.length !== 1 || !Number.isSafeInteger(artifact.id) || artifact.id < 1 || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '')) throw new Error('Harness artifact ZIP identity is missing.');
  const destination = path.resolve(env.TRITONAI_HARNESS_RUN_ARTIFACT_DIR);
  if (fs.existsSync(destination)) throw new Error('Harness artifact destination must be absent before exact extraction.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(path.dirname(destination), '.harness-artifact-'));
  try {
    const archive = path.join(scratch, 'artifact.zip');
    fetchZip(artifact.id, archive);
    if (!fs.lstatSync(archive).isFile() || fs.statSync(archive).size !== artifact.size || `sha256:${sha256(archive)}` !== artifact.digest) throw new Error('Harness artifact ZIP differs from the frozen successful-run digest.');
    const unpacked = path.join(scratch, 'unpacked');
    fs.mkdirSync(unpacked);
    if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-x', '-k', archive, unpacked], { stdio: 'inherit' });
    else if (process.platform === 'win32') execFileSync('tar.exe', ['-xf', archive, '-C', unpacked], { stdio: 'inherit' });
    else throw new Error('Harness desktop artifact extraction requires its Mac or Windows packaging host.');
    fs.renameSync(unpacked, destination);
    console.log(`Verified Harness ${name} artifact ${artifact.id} from run ${selection.runId} attempt ${receipt.runAttempt}.`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

if (require.main === module) downloadArtifact();
module.exports = { downloadArtifact, sha256 };
