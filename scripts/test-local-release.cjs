const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, resolveRef, profileFor, rustTools, cleanEnvironment, installerConfigurationEnvironment, frozenInstallerEnvironment, inspectHostCommands, assertResumeSelections, candidateEnvironment, macSigningEnvironment, freeze, freezeTools, assertToolIdentities, hash, save, failureExitCode } = require('./local-release.cjs');
const { makeBuildRecipe, assertVersionOnly, executeWithEnvironment } = require('./local-release-stages.cjs');
const { run } = require('./release-runner.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
function repo(root, name) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.3.3","name":"fixture"}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'initial'); return dir;
}
test('simple version command and explicit plugin/skills refs have strict arguments', () => {
  assert.deepEqual(parseArgs(['0.3.4', '--plugins', 'v0.1.3', '--skills', 'release/approved']), { version: '0.3.4', plugins: 'v0.1.3', skills: 'release/approved' });
  assert.throws(() => parseArgs(['0.3.4', '--plugins']), /requires/);
  assert.throws(() => parseArgs(['0.3.4', '--jobs', '9']), /1 or 2/);
  assert.throws(() => parseArgs(['0.3.4', '--publish']), /Unknown/);
  assert.equal(parseArgs(['0.3.4', '--scope', 'harness']).scope, 'harness');
  assert.throws(() => parseArgs(['0.3.4', '--scope', 'nightly']), /harness or full/);
  assert.throws(() => parseArgs(['0.3.4', '--scope', 'harness', '--skills', 'main']), /only to --scope full/);
});
test('main comes from fresh remote; tag and full SHA selection never use stale local main', t => {
  const root = fixture(t), origin = repo(root, 'origin'), checkout = path.join(root, 'checkout');
  execFileSync('git', ['clone', origin, checkout], { stdio: 'pipe' });
  const old = git(origin, 'rev-parse', 'HEAD'); git(origin, 'tag', 'v1.0.0');
  fs.writeFileSync(path.join(origin, 'new'), 'new'); git(origin, 'add', '.'); git(origin, 'commit', '-m', 'advance');
  const fresh = git(origin, 'rev-parse', 'HEAD');
  assert.equal(resolveRef(checkout, 'main').commit, fresh);
  assert.equal(git(checkout, 'rev-parse', 'main'), old);
  assert.equal(resolveRef(checkout, 'v1.0.0').commit, old);
  assert.equal(resolveRef(checkout, fresh).commit, fresh);
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(checkout, 'local-only'), 'tooling fix'); git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'local tooling fix');
  const local = git(checkout, 'rev-parse', 'HEAD'); assert.equal(resolveRef(checkout, local).commit, local);
  git(origin, 'tag', 'main'); assert.throws(() => resolveRef(checkout, 'main'), /Ambiguous/);
  assert.equal(resolveRef(checkout, 'refs/heads/main').commit, fresh);
  git(origin, 'branch', 'temporary-release', fresh);
  assert.equal(resolveRef(checkout, 'temporary-release').commit, fresh);
  git(origin, 'branch', '-D', 'temporary-release');
  assert.throws(() => resolveRef(checkout, 'temporary-release'), /Unknown remote branch/);
  git(origin, 'tag', '-d', 'v1.0.0');
  assert.throws(() => resolveRef(checkout, 'v1.0.0'), /Unknown remote branch\/tag/);
  assert.throws(() => resolveRef(checkout, 'refs/tags/v1.0.0'), /Unknown remote tag/);
  for (const ref of ['HEAD~1', '-x', 'main:secret', '../main']) assert.throws(() => resolveRef(checkout, ref), /Invalid/);
});
test('resume freezes selectors and configuration, not moving latest refs', t => {
  const root = fixture(t), file = path.join(root, 'config.json'); save(file, { github: { clientId: 'fixture' }, unused: {} });
  const c = { version: '0.3.4', configurationFile: file, configurationSha256: hash(JSON.stringify({ github: { clientId: 'fixture' } })), pluginIds: ['github'], tools: {}, developerId: 'Fixture', notary: {}, sources: Object.fromEntries(['harness', 'installer', 'plugins', 'skills'].map(k => [k, { selection: 'main', commit: 'a'.repeat(40) }])) };
  assert.doesNotThrow(() => assertResumeSelections(c, { version: '0.3.4' }));
  assert.throws(() => assertResumeSelections(c, { version: '0.3.4', skills: 'other' }), /selection differs/);
  assert.equal(JSON.parse(candidateEnvironment(c).TRITONAI_PLUGIN_CONFIGURATION_JSON).github.clientId, 'fixture');
  save(file, { github: { clientId: 'changed' } }); assert.throws(() => candidateEnvironment(c), /configuration changed/);
});
test('release environment excludes ambient build overrides without mutating parent', () => {
  const input = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', Node_Path: '/ambient', Electron_Run_As_Node: '1', NODE_OPTIONS: '--bad', TRITONAI_PLUGINS_REF: 'wrong', APPLE_API_KEY: 'ambient', WINEPREFIX: '/shared', KEEP: 'yes' };
  const result = cleanEnvironment(input, { node: '/tools/node', vp: '/vite/vp' });
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined); assert.equal(result.TRITONAI_PLUGINS_REF, undefined); assert.equal(result.APPLE_API_KEY, undefined);
  assert.equal(result.PATH, ['/tools', '/vite', '/usr/bin'].join(path.delimiter)); assert.equal(result.KEEP, 'yes'); assert.equal(input.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(result.Node_Path, undefined); assert.equal(result.Electron_Run_As_Node, undefined);
});

test('Installer configuration requires explicit valid values and leaves omitted defaults to its source', () => {
  assert.deepEqual(installerConfigurationEnvironment({ baseUrl: 'https://api.example.test/v1/' }), { UCSD_AI_BASE_URL: 'https://api.example.test/v1' });
  assert.deepEqual(installerConfigurationEnvironment({ baseUrl: 'https://api.example.test/v1', apiDocsUrl: 'https://docs.example.test/', codexModel: 'selected', restrictedCodexModel: 'restricted', externalModelProbe: 'probe' }), {
    UCSD_AI_BASE_URL: 'https://api.example.test/v1', UCSD_AI_DOCS_URL: 'https://docs.example.test', UCSD_CODEX_MODEL: 'selected', UCSD_RESTRICTED_CODEX_MODEL: 'restricted', UCSD_EXTERNAL_MODEL_PROBE: 'probe',
  });
  for (const configuration of [undefined, null, [], {}, { baseUrl: '' }, { baseUrl: 42 }, { baseUrl: 'not a URL' }, { baseUrl: 'file:///tmp/api' },
    { baseUrl: 'https://api.example.test', apiDocsUrl: null }, { baseUrl: 'https://api.example.test', codexModel: [] },
    { baseUrl: 'https://api.example.test', restrictedCodexModel: ' ' }, { baseUrl: 'https://api.example.test', baseURL: 'typo' }]) {
    assert.throws(() => installerConfigurationEnvironment(configuration), /installerConfiguration/);
  }
  assert.throws(() => frozenInstallerEnvironment({}), /use --fresh/);
  assert.throws(() => frozenInstallerEnvironment({ installerEnvironment: { UCSD_AI_BASE_URL: 'https://api.example.test', NODE_OPTIONS: 'unreviewed' } }), /Unexpected frozen Installer environment field/);
});

test('freeze persists Installer configuration and resume ignores changed profile and ambient values', async t => {
  const root = fixture(t), origin = repo(root, 'config-origin'), checkout = path.join(root, 'config-checkout');
  const original = git(origin, 'rev-parse', 'HEAD');
  save(path.join(origin, 'package.json'), { version: '0.3.3', scripts: { 'release:local': 'node scripts/local-release.cjs' } });
  save(path.join(origin, 'config/managed-plugin-catalog.json'), { source: { commit: original }, packages: [{ pluginId: 'github' }] });
  save(path.join(origin, 'scripts/verify-macos-desktop-package.ts'), {});
  save(path.join(origin, 'tsconfig.plugin-producer.json'), {});
  git(origin, 'add', '.'); git(origin, 'commit', '-m', 'release configuration fixture');
  execFileSync('git', ['clone', origin, checkout], { stdio: 'pipe' });
  const configurationFile = path.join(root, 'plugin-config.json'), keyFile = path.join(root, 'notary-key');
  save(configurationFile, { github: {} }); fs.writeFileSync(keyFile, 'fixture');
  const settings = { profileFile: path.join(root, 'profile.json'), profile: { pluginConfigurationFile: configurationFile, installerConfiguration: { baseUrl: 'https://api.example.test/v1' } },
    repos: Object.fromEntries(['harness', 'installer', 'plugins', 'skills'].map(name => [name, checkout])), tools: { node: process.execPath } };
  const ready = { configuration: { github: {} }, identity: 'Fixture', notary: { keyFile }, installerEnvironment: installerConfigurationEnvironment(settings.profile.installerConfiguration) };
  await assert.rejects(freeze({ version: '0.3.4', plugins: 'main', harness: original }, settings, ready), /predates single-pass/);
  const candidate = await freeze({ version: '0.3.4', plugins: 'main' }, settings, ready);
  // Harness-only selection succeeds without a skills repository or Installer configuration.
  const harnessCandidate = await freeze({ version: '0.3.4', plugins: 'main', scope: 'harness' },
    { ...settings, repos: { ...settings.repos, skills: '/nonexistent/skills' } }, { ...ready, installerEnvironment: undefined });
  assert.equal(harnessCandidate.scope, 'harness');
  assert.equal(harnessCandidate.sources.skills, undefined);
  assert(harnessCandidate.sources.installer.commit, 'the composition producer remains pinned');
  assert.deepEqual(frozenInstallerEnvironment(harnessCandidate), {});
  assert.throws(() => assertResumeSelections(harnessCandidate, { version: '0.3.4' }), /scope differs/);
  assert.doesNotThrow(() => assertResumeSelections(harnessCandidate, { version: '0.3.4', scope: 'harness' }));
  const candidateFile = path.join(root, 'candidate.json'); save(candidateFile, candidate);
  settings.profile.installerConfiguration.baseUrl = 'https://changed.example.test';
  ready.installerEnvironment.UCSD_AI_BASE_URL = 'https://also-changed.example.test';
  const saved = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  const frozen = frozenInstallerEnvironment(saved);
  assert.deepEqual(frozen, { UCSD_AI_BASE_URL: 'https://api.example.test/v1' });
  assert.deepEqual(candidate.installerEnvironment, frozen);
  const ambient = cleanEnvironment({ UCSD_AI_BASE_URL: 'https://ambient.example.test', UCSD_CODEX_MODEL: 'ambient-model' });
  assert.deepEqual({ ...ambient, ...frozen }, { PATH: '', UCSD_AI_BASE_URL: 'https://api.example.test/v1' });
  assert.equal(frozen.UCSD_CODEX_MODEL, undefined, 'the frozen source selects the default model');
});

test('host preflight reports missing package managers and packaging utilities before building', () => {
  const missing = new Set(['corepack', 'hdiutil', '/usr/sbin/lsof']);
  const problems = inspectHostCommands({}, { platform: 'darwin', find: name => missing.has(name) ? null : name, execute: () => '' });
  for (const name of missing) assert.ok(problems.some(message => message.includes(name)));
});

test('host preflight detects unusable package managers and incomplete selected Xcode tools', () => {
  const calls = [];
  const problems = inspectHostCommands({}, { platform: 'darwin', find: name => name, execute: (name, args) => {
    calls.push([name, ...args]);
    if (name === 'corepack' || args.includes('stapler')) throw new Error('fixture unavailable');
    return '';
  } });
  assert.ok(problems.some(message => message.includes('corepack is installed but cannot run')));
  assert.ok(problems.some(message => message.includes('Xcode toolchain cannot locate stapler')));
  assert.ok(calls.some(call => call.join(' ') === 'xcrun --find notarytool'));
  assert.ok(calls.some(call => call.join(' ') === 'xcrun --find clang'));
});
test('Rust selection resolves rustup proxies and honors explicit compiler paths', () => {
  const calls = [];
  const options = { find: name => name === 'rustup' ? '/proxy/rustup' : name, realpath: file => file, execute: (file, args) => {
    calls.push([file, ...args]); return `/toolchain/bin/${args[1]}\n`;
  } };
  assert.deepEqual(rustTools({}, options), { cargo: '/toolchain/bin/cargo', rustc: '/toolchain/bin/rustc' });
  assert.deepEqual(calls, [['/proxy/rustup', 'which', 'cargo'], ['/proxy/rustup', 'which', 'rustc']]);
  assert.deepEqual(rustTools({ cargo: '/fixed/cargo', rustc: '/fixed/rustc' }, options), { cargo: '/fixed/cargo', rustc: '/fixed/rustc' });
  assert.equal(calls.length, 2, 'explicit ordinary compilers must not be replaced by the default rustup selection');
});
test('explicit symlink and hardlink rustup proxies freeze selected toolchain binaries and derive their linker', { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t), proxyBin = path.join(root, 'custom-rustup/bin'), toolchain = path.join(root, 'selected-toolchain');
  const writeExecutable = (file, contents) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents, { mode: 0o755 }); return file; };
  const cargo = writeExecutable(path.join(toolchain, 'bin/cargo'), '#!/bin/sh\nexit 0\n');
  const rustc = writeExecutable(path.join(toolchain, 'bin/rustc'), '#!/bin/sh\nexit 0\n');
  const host = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  const linker = writeExecutable(path.join(toolchain, 'lib/rustlib', host, 'bin/gcc-ld/lld-link'), '#!/bin/sh\nexit 0\n');
  // This selector deliberately lives outside ~/.cargo and returns a different
  // toolchain from the user's default rustup installation.
  const selector = writeExecutable(path.join(proxyBin, 'rustup'), `#!/bin/sh\n[ "$1" = which ] || exit 1\ncase "$2" in cargo|rustc) printf '%s/%s\\n' '${toolchain}/bin' "$2" ;; *) exit 1 ;; esac\n`);
  fs.symlinkSync('rustup', path.join(proxyBin, 'rustc'));
  fs.linkSync(selector, path.join(proxyBin, 'cargo'));
  const profilePath = path.join(root, 'profile.json');
  save(profilePath, { schemaVersion: 1, node: process.execPath, vp: cargo, clang: cargo, cargoXwin: cargo, wine: cargo,
    cargo: path.join(proxyBin, 'cargo'), rustc: path.join(proxyBin, 'rustc') });
  const settings = profileFor({ profile: profilePath });
  assert.equal(settings.tools.cargo, fs.realpathSync(cargo));
  assert.equal(settings.tools.rustc, fs.realpathSync(rustc));
  assert.equal(settings.tools.lldLink, fs.realpathSync(linker));
  const frozen = await freezeTools({ cargo: settings.tools.cargo, rustc: settings.tools.rustc });
  assert.equal(frozen.tools.cargo, fs.realpathSync(cargo));
  assert.equal(frozen.tools.rustc, fs.realpathSync(rustc));
  assert.notEqual(frozen.toolIdentities.rustc.sha256, hash(fs.readFileSync(selector)));
});
test('an explicit unresolved rustup proxy fails before it can be frozen', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), selector = path.join(root, 'rustup'), proxy = path.join(root, 'rustc');
  fs.writeFileSync(selector, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.symlinkSync(selector, proxy);
  assert.throws(() => rustTools({ rustc: proxy }, { execute: () => { throw new Error('toolchain unavailable'); } }), /Cannot resolve the selected rustc rustup proxy/);
});
test('preflight rejects broken and unsupported Rust before source checks', () => {
  const tools = { cargo: '/fixed/cargo', rustc: '/fixed/rustc' };
  const options = { platform: 'darwin', find: name => name, exists: () => true, execute: (file) => {
    if (file === tools.rustc) throw new Error('dyld: missing LLVM dependency');
    return '';
  } };
  assert.ok(inspectHostCommands(tools, options).some(problem => problem.includes('rustc is installed but cannot run')));
  options.execute = file => file === tools.rustc ? 'rustc 1.94.0\nrelease: 1.94.0\n' : '';
  assert.ok(inspectHostCommands(tools, options).some(problem => problem.includes('Rust 1.95 or newer')));
  options.execute = (file, args) => args.includes('target-libdir') ? '/toolchain/target/lib' : file === tools.rustc ? 'rustc 1.95.0\nrelease: 1.95.0\n' : '';
  assert.deepEqual(inspectHostCommands(tools, options), []);
  options.exists = () => false;
  assert.ok(inspectHostCommands(tools, options).some(problem => problem.includes('lacks x86_64-pc-windows-msvc')));
  const env = cleanEnvironment({ PATH: '/broken/bin', RUSTC: '/broken/rustc', RUSTC_WRAPPER: '/ambient', CARGO_BUILD_TARGET: 'wrong-target' }, tools);
  assert.equal(env.PATH.split(path.delimiter)[0], '/fixed');
  assert.equal(env.RUSTC, tools.rustc);
  assert.equal(env.CARGO, tools.cargo);
  assert.equal(env.RUSTC_WRAPPER, undefined);
  assert.equal(env.CARGO_BUILD_TARGET, undefined);
});
test('version-only preparation refuses unrelated edits even in recognized manifests', t => {
  const root = fixture(t), cwd = repo(root, 'installer'), source = { commit: git(cwd, 'rev-parse', 'HEAD') };
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"version":"0.3.4","name":"fixture"}\n');
  assert.doesNotThrow(() => assertVersionOnly(cwd, source, 'installer', '0.3.4'));
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"version":"0.3.4","name":"altered"}\n');
  assert.throws(() => assertVersionOnly(cwd, source, 'installer', '0.3.4'), /beyond release version/);
});
test('recipe allows both platforms and their downstream installers to overlap with isolated cwd', t => {
  const root = fixture(t), file = path.join(root, 'candidate.json');
  const sources = Object.fromEntries(['harness', 'installer', 'plugins', 'skills'].map(k => [k, { commit: 'a'.repeat(40) }]));
  save(file, { version: '0.3.4', sources, tools: { node: process.execPath }, toolIdentities: { node: { path: process.execPath, sha256: 'e'.repeat(64) } }, notary: { keyFile: '/fixture/key', keySha256: 'b'.repeat(64) } });
  const dirs = Object.fromEntries(['harness-mac', 'harness-win', 'installer-mac', 'installer-win', 'plugins', 'skills'].map(k => [k, path.join(root, k)]));
  const recipe = makeBuildRecipe(file, { dirs, commits: { harness: 'a'.repeat(40), installer: 'a'.repeat(40) }, pluginInput: '/fixture/plugins', pluginHash: 'c'.repeat(64), catalogPath: '/fixture/catalog', catalogHash: 'd'.repeat(64) });
  const stage = id => recipe.steps.find(s => s.id === id);
  assert.notEqual(stage('harness-mac').cwd, stage('harness-win').cwd);
  assert.ok(!stage('harness-win').needs.includes('harness-mac'));
  assert.deepEqual(stage('installer-mac').needs, ['harness-mac']);
  assert.ok(!stage('installer-win').needs.includes('installer-mac'));
  assert.ok(stage('harness-mac').outputs.some(f => f.endsWith('harness-mac-verification.json')));
  assert.ok(stage('installer-win').outputs.some(f => f.endsWith('installer-win-verification.json')));
  assert.ok(stage('handoff').outputs.some(f => f.endsWith('installer-win-verification.json')));
  assert.ok(stage('handoff').outputs.some(f => f.endsWith('.exe')));
  assert.ok(stage('harness-win').inputs.some(f => f.sha256 === 'e'.repeat(64)));
});

test('notarization credentials are supplied only to explicit macOS signing commands', t => {
  const root = fixture(t), file = path.join(root, 'config.json'); save(file, { github: {} });
  const c = { configurationFile: file, configurationSha256: hash('{"github":{}}'), pluginIds: ['github'], tools: {}, developerId: 'Fixture', notary: { keyFile: '/private/fixture.p8', keyId: 'fixture', issuerId: 'fixture' } };
  const common = candidateEnvironment(c);
  for (const key of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'DEVELOPER_ID_APPLICATION']) assert.equal(common[key], undefined);
  assert.equal(macSigningEnvironment(c).APPLE_API_KEY, c.notary.keyFile);
});

test('frozen executable paths survive symlink updates and reject changed executable bytes', async t => {
  const root = fixture(t), executable = path.join(root, 'version-one'), next = path.join(root, 'version-two'), link = path.join(root, 'tool');
  fs.writeFileSync(executable, 'one'); fs.writeFileSync(next, 'two'); fs.symlinkSync(executable, link);
  const c = await freezeTools({ node: link });
  assert.equal(c.tools.node, fs.realpathSync(executable));
  fs.unlinkSync(link); fs.symlinkSync(next, link);
  await assertToolIdentities(c);
  fs.writeFileSync(executable, 'replacement');
  await assert.rejects(assertToolIdentities(c), /node executable changed/);
});
test('real child recipe runs in a configured environment, resumes, and rejects replaced outputs', async t => {
  const root = fixture(t), cwd = path.join(root, 'stage'); fs.mkdirSync(cwd);
  const step = { id: 'fixture', cwd, git: false, commands: [[process.execPath, '-e', "require('fs').writeFileSync('artifact',process.env.FIXTURE_VALUE)"]], outputs: ['artifact'] };
  const recipe = { schemaVersion: 1, steps: [step] }, state = path.join(root, 'state');
  await run(recipe, state, { executeCommand: executeWithEnvironment({ PATH: process.env.PATH, FIXTURE_VALUE: 'configured' }) });
  assert.equal(fs.readFileSync(path.join(cwd, 'artifact'), 'utf8'), 'configured');
  await run(recipe, state, { executeCommand: () => { throw new Error('must resume'); } });
  fs.writeFileSync(path.join(cwd, 'artifact'), 'replaced');
  await assert.rejects(run(recipe, state), /Completed stage changed/);
});

test('runner fingerprints the supplied release environment and delivers it to default executor', async t => {
  const root = fixture(t), cwd = path.join(root, 'stage'); fs.mkdirSync(cwd);
  const recipe = { schemaVersion: 1, steps: [{ id: 'env', cwd, git: false, requiredEnv: ['TRITONAI_TEST_CONFIG'], commands: [[process.execPath, '-e', "require('fs').writeFileSync('artifact',process.env.TRITONAI_TEST_CONFIG)"]], outputs: ['artifact'] }] };
  const environment = { PATH: process.env.PATH, TRITONAI_TEST_CONFIG: 'profile-value' }, state = path.join(root, 'state');
  await run(recipe, state, { environment });
  assert.equal(fs.readFileSync(path.join(cwd, 'artifact'), 'utf8'), 'profile-value');
  await assert.rejects(run(recipe, state, { environment: { ...environment, TRITONAI_TEST_CONFIG: 'changed' } }), /Completed stage changed/);
  assert.ok(!fs.readFileSync(path.join(state, 'state.json'), 'utf8').includes('profile-value'));
});

test('interrupting a child prevents downstream work even when it handles the signal successfully', async t => {
  const root = fixture(t), ready = path.join(root, 'ready');
  const recipe = { schemaVersion: 1, steps: [
    { id: 'first', cwd: root, git: false, commands: [[process.execPath, '-e', "process.on('SIGINT',()=>process.exit(0));require('fs').writeFileSync('ready','yes');setInterval(()=>{},1000)"]], outputs: ['ready'] },
    { id: 'next', cwd: root, git: false, needs: ['first'], commands: [[process.execPath, '-e', "require('fs').writeFileSync('must-not-run','yes')"]], outputs: ['must-not-run'] }
  ] };
  const stopped = assert.rejects(run(recipe, path.join(root, 'state'), { executeCommand: executeWithEnvironment({ PATH: process.env.PATH }) }), error => {
    assert.match(error.message, /SIGINT/);
    assert.equal(failureExitCode(error), 130);
    return true;
  });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  process.emit('SIGINT');
  await stopped;
  assert.ok(fs.existsSync(ready));
  assert.ok(!fs.existsSync(path.join(root, 'must-not-run')));
  assert.ok(!fs.existsSync(path.join(root, 'state/runner.lock')));
});

test('production stage CLI preserves cancellation status through its child and runner', async t => {
  const root = fixture(t), candidate = path.join(root, 'candidate.json');
  save(candidate, { tools: { vp: process.execPath } });
  save(path.join(root, 'prepared.json'), { dirs: { 'harness-win': root } });
  const log = fs.openSync(path.join(root, 'stage.log'), 'a');
  try {
    for (const status of [130, 143]) {
      fs.writeFileSync(path.join(root, 'i'), `process.exit(${status});`);
      await assert.rejects(executeWithEnvironment({ PATH: process.env.PATH })(
        [process.execPath, path.join(__dirname, 'local-release-stages.cjs'), 'harness-win-dependencies', candidate],
        { id: 'cancellation', cwd: root }, log), error => {
        assert.equal(error.exitCode, status);
        assert.equal(failureExitCode(error), status);
        return true;
      });
    }
  } finally { fs.closeSync(log); }
});

test('Harness-only recipe has no Installer or skills work and handoff preserves verified outputs', async t => {
  const root = fixture(t), file = path.join(root, 'candidate.json');
  const sources = Object.fromEntries(['harness', 'installer', 'plugins'].map(k => [k, { commit: 'a'.repeat(40) }]));
  save(file, { scope: 'harness', version: '0.3.4', sources, tools: { node: process.execPath }, toolIdentities: {}, notary: { keyFile: '/fixture/key' } });
  const dirs = Object.fromEntries(['harness-mac', 'harness-win', 'plugins', 'composition-producer'].map(k => [k, path.join(root, k)]));
  const prepared = { dirs, commits: { harness: 'a'.repeat(40) }, pluginInput: '/fixture/plugins', pluginHash: 'c'.repeat(64), catalogPath: path.join(root, 'catalog.json'), catalogHash: 'd'.repeat(64) };
  save(path.join(root, 'prepared.json'), prepared); save(prepared.catalogPath, { packages: [] });
  const recipe = makeBuildRecipe(file, prepared);
  assert(!recipe.steps.some(step => step.id.startsWith('installer-')));
  assert(!recipe.steps.some(step => step.sources.some(source => source.path?.endsWith('/skills'))));
  const ids = new Set(recipe.steps.map(step => step.id));
  for (const step of recipe.steps) for (const need of step.needs) assert(ids.has(need));
  const handoff = recipe.steps.find(step => step.id === 'handoff');
  assert.deepEqual(handoff.needs, ['harness-mac', 'harness-win']);
  assert(recipe.steps.every(step => step.sources.some(source => source.path === dirs['composition-producer'])));
  const { stage, harnessFiles } = require('./local-release-stages.cjs');
  for (const platform of ['mac', 'win']) for (const name of harnessFiles('0.3.4', platform)) {
    const artifact = path.join(root, 'harness', platform, name);
    fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, `fixture ${name}`);
  }
  await stage('handoff', file);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'handoff/report.json')));
  assert.equal(report.scope, 'harness');
  assert.equal(report.artifacts.length, harnessFiles('0.3.4', 'mac').length + harnessFiles('0.3.4', 'win').length);
  assert(report.artifacts.every(artifact => artifact.path.includes('/harness/')));
  assert(report.artifacts.every(artifact => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  assert(handoff.outputs.every(output => fs.existsSync(output)));
  await assert.rejects(stage('installer-mac', file), /excluded/);
});
