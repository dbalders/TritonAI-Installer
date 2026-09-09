#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { treeHash } = require('./release-runner.cjs');

async function macCredentialInputs(env, home = os.homedir()) {
  let files;
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) files = [path.resolve(env.APPLE_API_KEY)];
  else {
    const configFile = path.join(home, '.agents', 'secrets', 'appstore', 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!config.keyId || !config.issuerId || !config.keyFile) throw new Error('Invalid notarization configuration');
    files = [configFile, path.resolve(path.dirname(configFile), config.keyFile)];
  }
  return Promise.all(files.map(async file => ({ path: file, sha256: await treeHash(file) })));
}
async function prepare(directory, env = process.env, root = path.resolve(__dirname, '..'), operations = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  if (env.TRITONAI_HARNESS_VERSION !== version) throw new Error(`Set TRITONAI_HARNESS_VERSION=${version}; commit release versions before preparing.`);
  for (const name of ['UCSD_SKILLS_SOURCE', 'TRITONAI_PLUGINS_SOURCE', 'TRITONAI_PLUGINS_REF', 'TRITONAI_PLUGINS_COMMIT', 'RELEASE_HARNESS_ASSETS']) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  if (env.TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE !== '1') throw new Error('Set TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE=1 for the existing unsigned Windows lane.');
  if (fs.existsSync(directory)) throw new Error(fs.existsSync(path.join(directory, 'release.json'))
    ? 'Candidate directory already exists. Resume its recipe with release:run.'
    : 'Incomplete candidate directory already exists. Inspect and clean up its worktrees before retrying preparation.');
  const git = operations.git || ((cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim());
  for (const source of [root, env.UCSD_SKILLS_SOURCE, env.TRITONAI_PLUGINS_SOURCE]) {
    if (git(source, 'status', '--porcelain')) throw new Error(`Source must be clean: ${source}`);
  }
  if (git(env.TRITONAI_PLUGINS_SOURCE, 'rev-parse', 'HEAD') !== env.TRITONAI_PLUGINS_COMMIT ||
      git(env.TRITONAI_PLUGINS_SOURCE, 'rev-parse', `${env.TRITONAI_PLUGINS_REF}^{commit}`) !== env.TRITONAI_PLUGINS_COMMIT) throw new Error('Plugin source/ref does not match the existing commit pin.');
  const commit = git(root, 'rev-parse', 'HEAD');
  const assets = path.resolve(env.RELEASE_HARNESS_ASSETS);
  if (!fs.statSync(assets).isDirectory()) throw new Error('RELEASE_HARNESS_ASSETS must contain the verified Harness handoff.');
  const requiredAssets = [
    `TritonAI-Harness-${version}-arm64.dmg`, 'latest-mac.yml', 'tritonai-plugin-composition-mac-arm64.json',
    `TritonAI-Harness-${version}-x64.exe`, 'latest.yml', 'tritonai-plugin-composition-win-x64.json'
  ];
  for (const name of requiredAssets) if (!fs.statSync(path.join(assets, name)).isFile()) throw new Error(`Missing Harness asset: ${name}`);
  if (env.TRITONAI_HARNESS_RUN_ID && (!/^\d+$/.test(env.TRITONAI_HARNESS_RUN_ID) || !/^[a-f0-9]{40}$/.test(env.TRITONAI_HARNESS_COMMIT || ''))) throw new Error('Harness run requires a numeric ID and exact TRITONAI_HARNESS_COMMIT.');
  const assetHash = await treeHash(assets);
  const credentialInputs = await macCredentialInputs(env);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory, { mode: 0o700 });
  const created = [];
  try {
    // Separate worktrees prevent concurrent builds from sharing dist/ or vendor/.
    for (const platform of ['mac', 'win']) {
      const worktree = path.join(directory, platform);
      git(root, 'worktree', 'add', '--detach', worktree, commit);
      created.push(worktree);
    }
    const requiredEnv = [
      'UCSD_SKILLS_SOURCE', 'TRITONAI_PLUGINS_SOURCE', 'TRITONAI_PLUGINS_REF', 'TRITONAI_PLUGINS_COMMIT',
      'TRITONAI_HARNESS_VERSION', 'TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE'
    ];
    // Bind all provided release configuration by hash; never write values to the recipe.
    for (const name of Object.keys(env)) if (/^(TRITONAI_|UCSD_|T3CODE_|CSC_|WIN_CSC_|APPLE_|AZURE_|ELECTRON_BUILDER_|DEVELOPER_ID_APPLICATION$)/.test(name) && env[name] && !requiredEnv.includes(name)) requiredEnv.push(name);
    const steps = [];
    if (env.TRITONAI_HARNESS_RUN_ID) {
      steps.push({ id: 'harness-ci', cwd: path.join(directory, 'mac'), commands: [[process.execPath, path.join(root, 'scripts/wait-harness-release.cjs'), env.TRITONAI_HARNESS_RUN_ID, env.TRITONAI_HARNESS_COMMIT]], outputs: [], inputs: [path.join(root, 'scripts/wait-harness-release.cjs')], requiredEnv });
    }
    for (const platform of ['mac', 'win']) {
      const cwd = path.join(directory, platform);
      steps.push({ id: `${platform}-dependencies`, cwd, needs: env.TRITONAI_HARNESS_RUN_ID ? ['harness-ci'] : [], commands: [['npm', 'ci']], outputs: ['node_modules/.package-lock.json'], requiredEnv });
      if (platform === 'mac') steps.push({ id: `${platform}-tests`, cwd, needs: [`${platform}-dependencies`], commands: [['npm', 'test']], outputs: [], requiredEnv });
      const out = platform === 'mac' ? 'artifacts/macos-release' : 'artifacts/windows-installer';
      const files = platform === 'mac' ? [`TritonAI-Installer-${version}-arm64.dmg`, 'packaged-boot.json'] : [
        `TritonAI-Installer-Setup-${version}-x64.exe`, `TritonAI-Installer-Setup-${version}-x64.exe.blockmap`,
        `TritonAI-Installer-${version}-x64-portable.exe`, 'latest.yml', 'unsigned-release.json', 'SHA256SUMS-windows-unsigned.txt'
      ];
      steps.push({
        id: `${platform}-package`, cwd, needs: ['mac-tests', 'win-dependencies'],
        commands: [['npm', 'run', platform === 'mac' ? 'package:mac-release' : 'package:win-installer']],
        inputs: [{ path: assets, sha256: assetHash }, ...(platform === 'mac' ? credentialInputs : [])],
        sources: [env.UCSD_SKILLS_SOURCE, env.TRITONAI_PLUGINS_SOURCE].map(source => ({ path: path.resolve(source), commit: git(source, 'rev-parse', 'HEAD') })),
        requiredEnv,
        // Cross-build packaging shares Electron Builder's Wine/NSIS caches. Serialize it by default.
        resources: ['electron-builder-release-cache'],
        env: { TRITONAI_HARNESS_RELEASE_BASE: pathToFileURL(assets).href, TRITONAI_HARNESS_MAC_RELEASE_BASE: pathToFileURL(assets).href, TRITONAI_HARNESS_WIN_RELEASE_BASE: pathToFileURL(assets).href, ...(platform === 'win' ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {}) },
        outputs: files.map(name => `${out}/${name}`)
      });
    }
    const packageSteps = steps.filter(step => step.id.endsWith('-package'));
    const copies = packageSteps.flatMap(step => step.outputs.map(file => ({
      source: path.join(step.cwd, file),
      destination: path.join(directory, 'handoff', step.id.startsWith('mac') ? 'mac' : 'win', path.basename(file))
    })));
    steps.push({ id: 'handoff', cwd: path.join(directory, 'mac'), needs: ['mac-package', 'win-package'],
      commands: [[process.execPath, path.join(root, 'scripts/collect-release-artifacts.cjs'), JSON.stringify(copies)]],
      inputs: [...copies.map(copy => copy.source), path.join(root, 'scripts/collect-release-artifacts.cjs')], outputs: copies.map(copy => copy.destination) });
    for (const step of steps) step.commit = commit;
    const recipe = path.join(directory, 'release.json');
    (operations.writeRecipe || fs.writeFileSync)(recipe, JSON.stringify({ schemaVersion: 1, steps }, null, 2) + '\n', { mode: 0o600 });
    return recipe;
  } catch (error) {
    const cleanupErrors = [];
    for (const worktree of created.reverse()) {
      try { git(root, 'worktree', 'remove', worktree); }
      catch { cleanupErrors.push(worktree); }
    }
    try { fs.rmSync(path.join(directory, 'release.json'), { force: true }); } catch { cleanupErrors.push(path.join(directory, 'release.json')); }
    // Never recursively delete an unexpected file or a worktree that became dirty.
    try { fs.rmdirSync(directory); } catch { cleanupErrors.push(directory); }
    if (cleanupErrors.length) throw new Error(`${error.message}. Preparation cleanup incomplete; inspect: ${cleanupErrors.join(', ')}`);
    throw error;
  }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3 || process.argv[2] === '--help') console.log('Usage: npm run release:prepare -- <new absolute candidate directory>\nUses the existing TRITONAI/UCSD release environment and RELEASE_HARNESS_ASSETS. Creates two Installer worktrees and a resumable recipe; does not build or publish.');
    else prepare(path.resolve(process.argv[2])).then(recipe => console.log(recipe)).catch(error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare, macCredentialInputs };
