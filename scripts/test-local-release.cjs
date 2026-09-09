const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, resolveRef, cleanEnvironment, inspectHostCommands, assertResumeSelections, candidateEnvironment, macSigningEnvironment, freezeTools, assertToolIdentities, hash, save, failureExitCode } = require('./local-release.cjs');
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
