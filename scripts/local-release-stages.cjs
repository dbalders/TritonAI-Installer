#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { isDeepStrictEqual } = require('node:util');
const { read, save, git, candidateEnvironment, macSigningEnvironment, failureExitCode } = require('./local-release.cjs');
const { treeHash } = require('./release-runner.cjs');
const { collect } = require('./collect-release-artifacts.cjs');
const childExitCode = (code, signal) => signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code || 1;

function executeWithEnvironment(environment) {
  return (command, step, log) => new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: step.cwd,
      env: { ...environment, ...step.env }, stdio: ['ignore', log, log], shell: false, detached: process.platform !== 'win32' });
    let interrupted;
    const forward = signal => { interrupted = signal; if (child.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch {} } };
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const finish = error => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); error ? reject(error) : resolve(); };
    child.once('error', finish);
    child.once('exit', (code, signal) => finish(code === 0 && !interrupted ? null : Object.assign(
      new Error(`${step.id} failed (${interrupted || code || signal}); see its stage log.`),
      { exitCode: childExitCode(code, interrupted || signal) })));
  });
}

function command(cwd, argv, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Object.assign(
      new Error(`${path.basename(argv[0])} ${argv[1] || ''} failed (${code ?? signal})`),
      { exitCode: childExitCode(code, signal) })));
  });
}

function ensureWorktree(source, destination, commit = source.commit) {
  if (!fs.existsSync(destination)) git(source.repo, 'worktree', 'add', '--detach', destination, commit);
  if (git(destination, 'rev-parse', '--show-toplevel') !== fs.realpathSync(destination)) throw new Error(`Unexpected worktree at ${destination}`);
  return destination;
}

function versionFiles(kind) {
  return kind === 'harness' ? ['apps/server/package.json', 'apps/desktop/package.json', 'apps/web/package.json', 'packages/contracts/package.json'] : ['package.json', 'package-lock.json'];
}
function assertVersionOnly(cwd, source, kind, version) {
  const expected = versionFiles(kind);
  const changed = git(cwd, 'diff', '--name-only', source.commit).split('\n').filter(Boolean);
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard');
  if (untracked || changed.some(file => !expected.includes(file))) throw new Error(`Unexpected source changes in ${cwd}; inspect before resuming.`);
  for (const file of changed) {
    const original = JSON.parse(git(cwd, 'show', `${source.commit}:${file}`));
    const current = read(path.join(cwd, file));
    original.version = version;
    if (file === 'package-lock.json' && original.packages?.['']) original.packages[''].version = version;
    if (JSON.stringify(original) !== JSON.stringify(current)) throw new Error(`Changes beyond release version in ${cwd}/${file}`);
  }
}
async function applyVersion(cwd, source, kind, version, node) {
  assertVersionOnly(cwd, source, kind, version);
  if (kind === 'harness') await command(cwd, [node, 'scripts/update-release-package-versions.ts', version]);
  else if (read(path.join(cwd, 'package.json')).version !== version) await command(cwd, ['npm', 'version', version, '--no-git-tag-version', '--ignore-scripts']);
  assertVersionOnly(cwd, source, kind, version);
  if (git(cwd, 'status', '--porcelain')) {
    git(cwd, 'add', '--', ...versionFiles(kind));
    git(cwd, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', `chore(release): prepare local ${version}`);
  }
  return git(cwd, 'rev-parse', 'HEAD');
}

async function prepare(candidateFile) {
  const candidate = read(candidateFile), root = path.dirname(candidateFile), { sources, tools } = candidate;
  const dirs = Object.fromEntries(['harness-mac', 'harness-win', 'installer-mac', 'installer-win', 'plugins', 'skills'].map(id => [id, path.join(root, 'worktrees', id)]));
  fs.mkdirSync(path.join(root, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'proof'), { recursive: true });
  for (const kind of ['plugins', 'skills']) {
    ensureWorktree(sources[kind], dirs[kind]);
    if (git(dirs[kind], 'rev-parse', 'HEAD') !== sources[kind].commit || git(dirs[kind], 'status', '--porcelain')) throw new Error(`${kind} input checkout changed; inspect before resuming.`);
  }
  for (const kind of ['harness', 'installer']) {
    ensureWorktree(sources[kind], dirs[`${kind}-mac`]);
    assertVersionOnly(dirs[`${kind}-mac`], sources[kind], kind, candidate.version);
  }
  // These installs intentionally run repository hooks, including effect-tsgo patch.
  await Promise.all([
    command(dirs['harness-mac'], [tools.vp, 'i']),
    command(dirs['installer-mac'], ['npm', 'ci', '--no-audit', '--no-fund'])
  ]);
  await command(dirs.plugins, ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
  const commits = {};
  for (const kind of ['harness', 'installer']) {
    commits[kind] = await applyVersion(dirs[`${kind}-mac`], sources[kind], kind, candidate.version, tools.node);
    ensureWorktree(sources[kind], dirs[`${kind}-win`], commits[kind]);
    if (git(dirs[`${kind}-win`], 'rev-parse', 'HEAD') !== commits[kind] || git(dirs[`${kind}-win`], 'status', '--porcelain')) throw new Error(`${kind} Windows worktree differs from frozen version commit.`);
  }
  await command(dirs['installer-mac'], ['npm', 'run', 'build']);
  const vendor = require(path.join(dirs['installer-mac'], 'dist/scripts/prepare-plugins-vendor.js'));
  if (!vendor.createLocalCandidatePluginCatalog) throw new Error('Selected Installer lacks local candidate support. Select a version containing the release workflow changes.');
  const pluginInput = path.join(root, 'inputs/plugins');
  const catalogPath = path.join(root, 'inputs/plugin-catalog.json');
  if (!fs.existsSync(catalogPath)) {
    await command(dirs['installer-mac'], [tools.node, 'dist/scripts/prepare-plugins-vendor.js'], {
      ...process.env, TRITONAI_LOCAL_RELEASE_CANDIDATE: '', TRITONAI_PLUGIN_CATALOG_PATH: '',
      TRITONAI_PLUGINS_SOURCE: dirs.plugins, TRITONAI_PLUGINS_REF: sources.plugins.commit,
      TRITONAI_PLUGINS_COMMIT: sources.plugins.commit, TRITONAI_PLUGIN_IDS: candidate.pluginIds.join(',')
    });
    const manifest = read(path.join(dirs['installer-mac'], 'vendor/plugins/manifest.json'));
    if (candidate.catalogSelection) {
      const catalog = read(path.join(dirs['installer-mac'], 'config/managed-plugin-catalog.json'));
      // The commit pin is immutable; compare package bytes independently of branch spelling.
      const actual = vendor.createLocalCandidatePluginCatalog(manifest);
      if (JSON.stringify(actual.packages) !== JSON.stringify(catalog.packages) || actual.source.commit !== catalog.source.commit) throw new Error('Selected default plugin bytes differ from the reviewed catalog.');
    }
    const generated = path.join(dirs['installer-mac'], 'vendor/plugins');
    if (fs.existsSync(pluginInput)) {
      if (await treeHash(pluginInput) !== await treeHash(generated)) throw new Error(`Incomplete plugin input differs at ${pluginInput}; inspect before resuming preparation.`);
    } else fs.cpSync(generated, pluginInput, { recursive: true, dereference: false });
    save(catalogPath, vendor.createLocalCandidatePluginCatalog(manifest));
  }
  const frozen = read(path.join(pluginInput, 'manifest.json'));
  require(path.join(dirs['installer-mac'], 'dist/src/installer/plugin-catalog.js')).assertCatalogComposition(read(catalogPath), frozen);
  save(path.join(root, 'prepared.json'), { dirs, commits, pluginInput, catalogPath,
    pluginHash: await treeHash(pluginInput), catalogHash: await treeHash(catalogPath) });
}

function harnessFiles(version, platform) {
  const prefix = `TritonAI-Harness-${version}-${platform === 'mac' ? 'arm64' : 'x64'}`;
  return platform === 'mac'
    ? [`${prefix}.dmg`, `${prefix}.dmg.blockmap`, `${prefix}.zip`, `${prefix}.zip.blockmap`, 'latest-mac.yml', 'tritonai-plugin-composition-mac-arm64.json', 'harness-mac-verification.json']
    : [`${prefix}.exe`, `${prefix}.exe.blockmap`, 'latest.yml', 'tritonai-plugin-composition-win-x64.json', 'harness-win-verification.json', 'resource-monitor-win-verification.json'];
}
function installerFiles(version, platform) {
  return platform === 'mac' ? [`TritonAI-Installer-${version}-arm64.dmg`, 'packaged-boot.json'] : [
    `TritonAI-Installer-Setup-${version}-x64.exe`, `TritonAI-Installer-Setup-${version}-x64.exe.blockmap`,
    `TritonAI-Installer-${version}-x64-portable.exe`, 'latest.yml', 'unsigned-release.json', 'SHA256SUMS-windows-unsigned.txt'];
}

function makeBuildRecipe(candidateFile, prepared) {
  const c = read(candidateFile), root = path.dirname(candidateFile), { dirs, commits } = prepared;
  const inputFiles = [candidateFile, path.join(root, 'prepared.json'), ...fs.readdirSync(__dirname).filter(n => /^local-release.*\.cjs$/.test(n)).map(n => path.join(__dirname, n)),
    { path: prepared.pluginInput, sha256: prepared.pluginHash }, { path: prepared.catalogPath, sha256: prepared.catalogHash }, { path: c.notary.keyFile, sha256: c.notary.keySha256 }, ...Object.values(c.toolIdentities)];
  const steps = [];
  function step(id, cwd, needs, outputs, commit) {
    steps.push({ id, cwd, needs, outputs, ...(commit ? { commit } : { git: false }),
      inputs: inputFiles, sources: [{ path: dirs.plugins, commit: c.sources.plugins.commit }, { path: dirs.skills, commit: c.sources.skills.commit }],
      commands: [[c.tools.node, path.join(__dirname, 'local-release-stages.cjs'), id, candidateFile]] });
  }
  step('validate-inputs', dirs['harness-mac'], [], [path.join(root, 'proof/plugin-validation.json')], commits.harness);
  step('harness-checks', dirs['harness-mac'], ['validate-inputs'], [path.join(root, 'proof/harness-checks.json')], commits.harness);
  step('installer-checks', dirs['installer-mac'], ['validate-inputs'], [path.join(root, 'proof/installer-checks.json')], commits.installer);
  step('plugins-checks', dirs.plugins, ['validate-inputs'], [path.join(root, 'proof/plugins-checks.json')], c.sources.plugins.commit);
  for (const kind of ['harness', 'installer']) step(`${kind}-win-dependencies`, dirs[`${kind}-win`], ['validate-inputs'], ['node_modules/.modules.yaml'].map(f => kind === 'installer' ? 'node_modules/.package-lock.json' : f), commits[kind]);
  step('windows-tools', dirs['installer-mac'], ['installer-checks'], [path.join(root, 'proof/windows-tools.json')], commits.installer);
  const gates = ['harness-checks', 'installer-checks', 'plugins-checks'];
  for (const platform of ['mac', 'win']) {
    const out = path.join(root, 'harness', platform);
    step(`harness-${platform}`, dirs[`harness-${platform}`], [...gates, ...(platform === 'win' ? ['harness-win-dependencies', 'windows-tools'] : [])], harnessFiles(c.version, platform).map(f => path.join(out, f)), commits.harness);
    step(`installer-${platform}`, dirs[`installer-${platform}`], [`harness-${platform}`, ...(platform === 'win' ? ['installer-win-dependencies'] : [])], installerFiles(c.version, platform).map(f => path.join(dirs[`installer-${platform}`], 'artifacts', platform === 'mac' ? 'macos-release' : 'windows-installer', f)), commits.installer);
  }
  step('handoff', path.join(root, 'proof'), ['installer-mac', 'installer-win'], [path.join(root, 'handoff/report.json'), path.join(root, 'handoff/SHA256SUMS.txt')]);
  // Explicit outputs make the handoff immutable too, including its copied binaries.
  for (const platform of ['mac', 'win']) for (const [kind, files] of [['harness', harnessFiles(c.version, platform)], ['installer', installerFiles(c.version, platform)]]) steps.at(-1).outputs.push(...files.map(file => path.join(root, 'handoff', platform, kind, file)));
  return { schemaVersion: 1, steps };
}

async function platformEnvironment(root, platform, c, p) {
  const env = { ...candidateEnvironment(c), TRITONAI_LOCAL_RELEASE_CANDIDATE: '1', UCSD_SKILLS_SOURCE: p.dirs.skills, TRITONAI_PLUGIN_COMPOSITION_SOURCE: p.pluginInput,
    TRITONAI_PLUGIN_CATALOG_PATH: p.catalogPath, TRITONAI_PLUGINS_SOURCE: p.dirs.plugins,
    TRITONAI_HARNESS_VERSION: c.version, TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE: '1' };
  const tmp = path.join(root, 'tmp', platform); fs.mkdirSync(tmp, { recursive: true }); env.TMPDIR = tmp + path.sep;
  env.ELECTRON_BUILDER_CACHE = path.join(root, 'toolchains', platform, 'electron-builder');
  env.ELECTRON_CACHE = path.join(root, 'toolchains', platform, 'electron');
  if (platform === 'win') {
    const { prepareWindowsToolchain } = require('./local-release-windows.cjs');
    const toolchain = await prepareWindowsToolchain({ root: path.join(root, 'toolchains/win'), candidateRoot: root, installerRoot: p.dirs['installer-mac'], wine: c.tools.wine, env });
    if (!isDeepStrictEqual(toolchain.receipt, read(path.join(root, 'proof/windows-tools.json')))) throw new Error('Windows toolchain changed from its prepared receipt; use --fresh.');
    Object.assign(env, toolchain.env);
    // Mac credentials never participate in the explicitly unsigned Windows lane.
    for (const key of Object.keys(env)) if (/^(APPLE_|CSC_|WIN_CSC_|AZURE_)/.test(key) || key === 'DEVELOPER_ID_APPLICATION') delete env[key];
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }
  return env;
}

async function stage(id, candidateFile) {
  if (id === 'prepare') return prepare(candidateFile);
  const c = read(candidateFile), root = path.dirname(candidateFile), p = read(path.join(root, 'prepared.json'));
  const { dirs } = p;
  const stamp = name => save(path.join(root, `proof/${name}.json`), { completedAt: new Date().toISOString(), sources: c.sources });
  if (id === 'validate-inputs') {
    const receipt = path.join(root, 'proof/plugin-validation.json');
    fs.rmSync(receipt, { force: true });
    return command(dirs['harness-mac'], [c.tools.node, 'scripts/validate-managed-plugin-configuration.ts', '--receipt', receipt], { ...process.env, TRITONAI_PLUGIN_COMPOSITION_SOURCE: p.pluginInput });
  }
  if (id.endsWith('-checks')) {
    const kind = id.split('-')[0], cwd = dirs[kind === 'plugins' ? kind : `${kind}-mac`];
    // Honor the server's serial SQLite/Git test configuration. The root runner
    // otherwise discovers those files without loading apps/server/vite.config.ts.
    const commands = kind === 'harness' ? [[c.tools.vp, 'check'], [c.tools.vp, 'run', 'typecheck'],
      [c.tools.vp, 'test', 'run', '--maxWorkers=2', '--exclude', 'apps/server/**'],
      [c.tools.vp, 'test', 'run', '--root', 'apps/server', '--maxWorkers=1'],
      [c.tools.vp, 'run', 'build']]
      : kind === 'installer' ? [['npm', 'test']] : [['corepack', 'pnpm', 'readiness:local']];
    for (const argv of commands) await command(cwd, argv, { ...process.env, TRITONAI_HARNESS_ROOT: dirs['harness-mac'], TRITONAI_HARNESS_COMMIT: p.commits.harness });
    stamp(id); return;
  }
  if (id.endsWith('-dependencies')) return command(dirs[id.replace('-dependencies', '')], id.startsWith('harness') ? [c.tools.vp, 'i'] : ['npm', 'ci', '--no-audit', '--no-fund']);
  if (id === 'windows-tools') {
    const result = await require('./local-release-windows.cjs').prepareWindowsToolchain({ root: path.join(root, 'toolchains/win'), candidateRoot: root, installerRoot: dirs['installer-mac'], wine: c.tools.wine, env: process.env });
    save(path.join(root, 'proof/windows-tools.json'), result.receipt); return;
  }
  if (/^(harness|installer)-(mac|win)$/.test(id)) {
    const [kind, platform] = id.split('-'), cwd = dirs[id], env = await platformEnvironment(root, platform, c, p);
    const out = path.join(root, 'harness', platform); fs.mkdirSync(out, { recursive: true });
    if (kind === 'harness') {
      if (platform === 'win') {
        const native = await require('./local-release-native.cjs').buildWindowsResourceMonitor({
          root: path.join(root, 'toolchains/win/native'), harnessRoot: cwd,
          cargo: c.tools.cargo, rustc: c.tools.rustc, cargoXwin: c.tools.cargoXwin,
          clang: c.tools.clang, lldLink: c.tools.lldLink,
        });
        Object.assign(env, native.env);
        save(path.join(out, 'resource-monitor-win-verification.json'), native.receipt);
      }
      // A failed attempt may have left a kept stage. This directory belongs only
      // to this locked candidate lane; completed stages are never rerun here.
      fs.rmSync(env.TMPDIR, { recursive: true, force: true }); fs.mkdirSync(env.TMPDIR, { recursive: true });
      const args = [c.tools.node, 'scripts/build-desktop-artifact.ts', '--platform', platform, '--target', platform === 'mac' ? 'dmg' : 'nsis', '--arch', platform === 'mac' ? 'arm64' : 'x64', '--output-dir', out];
      if (platform === 'mac') args.push('--keep-stage');
      await command(cwd, args, env);
      if (platform === 'mac') await command(cwd, [c.tools.node, path.join(__dirname, 'local-release-mac.cjs'), cwd, env.TMPDIR, c.version, out], { ...env, ...macSigningEnvironment(c) });
      else {
        const artifact = path.join(out, `TritonAI-Harness-${c.version}-x64.exe`);
        const proof = await require('./local-release-payload.cjs').verifyWindowsHarness({ artifact, outputDirectory: out, composition: read(path.join(p.pluginInput, 'manifest.json')), version: c.version, installerRoot: dirs['installer-mac'] });
        await command(cwd, [c.tools.node, 'scripts/finalize-managed-plugin-proof.ts', '--platform', 'win', '--arch', 'x64', '--artifact', artifact, '--output-dir', out], env);
        save(path.join(out, 'harness-win-verification.json'), proof);
      }
    } else {
      Object.assign(env, { TRITONAI_HARNESS_RELEASE_BASE: pathToFileURL(out).href, TRITONAI_HARNESS_MAC_RELEASE_BASE: pathToFileURL(out).href, TRITONAI_HARNESS_WIN_RELEASE_BASE: pathToFileURL(out).href });
      await command(cwd, ['npm', 'run', platform === 'mac' ? 'package:mac-release' : 'package:win-installer'], { ...env, ...(platform === 'mac' ? macSigningEnvironment(c) : {}) });
    }
    return;
  }
  if (id === 'handoff') {
    const copies = [];
    for (const platform of ['mac', 'win']) for (const kind of ['harness', 'installer']) {
      const files = kind === 'harness' ? harnessFiles(c.version, platform) : installerFiles(c.version, platform);
      const source = kind === 'harness' ? path.join(root, 'harness', platform) : path.join(dirs[`${kind}-${platform}`], 'artifacts', platform === 'mac' ? 'macos-release' : 'windows-installer');
      for (const file of files) copies.push({ source: path.join(source, file), destination: path.join(root, 'handoff', platform, kind, file) });
    }
    await collect(copies);
    const artifacts = await Promise.all(copies.map(async copy => ({ path: path.relative(path.join(root, 'handoff'), copy.destination), sha256: await treeHash(copy.destination), bytes: fs.statSync(copy.destination).size })));
    fs.writeFileSync(path.join(root, 'handoff/SHA256SUMS.txt'), artifacts.map(a => `${a.sha256}  ${a.path}`).join('\n') + '\n');
    save(path.join(root, 'handoff/report.json'), { schemaVersion: 1, version: c.version, sources: c.sources, releaseCommits: p.commits,
      plugins: read(p.catalogPath), artifacts, published: false, windows: { signed: false, nativeBoot: 'not-verified', note: 'Run verify:win-installer:native on these exact artifacts on Windows.' } });
    return;
  }
  throw new Error(`Unknown release stage: ${id}`);
}

if (require.main === module) stage(process.argv[2], path.resolve(process.argv[3])).catch(error => { console.error(error.message); process.exitCode = failureExitCode(error); });
module.exports = { executeWithEnvironment, command, ensureWorktree, assertVersionOnly, applyVersion, prepare, harnessFiles, installerFiles, makeBuildRecipe, platformEnvironment, stage };
