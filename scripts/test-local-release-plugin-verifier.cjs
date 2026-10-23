const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const { validatePluginVerificationTool, verifyPluginVerificationParity } = require('./local-release-plugin-verifier.cjs');
const { assertToolIdentities, save } = require('./local-release.cjs');
const { makeBuildRecipe, stage } = require('./local-release-stages.cjs');
// Controlled producer fixture; the separate integration check uses the exact Harness producer.
function stageFixture({ sourceRoot, vendorDir, selectedIds, source }) {
  const crypto = require('node:crypto');
  const packages = selectedIds.map(id => {
    const root = path.join(sourceRoot, 'plugins', id), metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const files = [];
    const hash = crypto.createHash('sha256');
    function visit(dir, prefix = '') {
      for (const name of fs.readdirSync(dir).sort()) {
        const relative = prefix + name, full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) visit(full, relative + '/');
        else {
          const bytes = fs.readFileSync(full);
          files.push({ path: relative, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
          hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
        }
      }
    }
    visit(root);
    return { id, name: metadata.name, version: metadata.version, files, digest: hash.digest('hex') };
  });
  const manifest = { source, packages };
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
const producer = { stagePluginsFromSource: stageFixture };
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-plugin-verifier-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'tool'), pkg = path.join(repo, 'plugins/github');
  fs.mkdirSync(pkg, { recursive: true });
  const manifest = { apiVersion: 'tritonai.harness/v2', kind: 'IntegrationPlugin', manifestVersion: 2,
    id: 'github', name: 'GitHub', description: 'Read github data.', version: '1.0.0',
    capabilities: [{ id: 'github.read', displayName: 'Read', description: 'Read data.', access: 'default' }],
    tools: [], skills: [{ name: 'github', description: 'Read github data.', capabilities: ['github.read'] }] };
  save(path.join(pkg, 'package.json'), { name: '@tritonai/plugin-github', version: '1.0.0', files: ['.tritonai-plugin', 'skills', 'README.md', 'SECURITY.md'] });
  save(path.join(pkg, '.tritonai-plugin/plugin.json'), manifest);
  fs.writeFileSync(path.join(pkg, 'README.md'), '# GitHub\n'); fs.writeFileSync(path.join(pkg, 'SECURITY.md'), '# Security\n');
  fs.mkdirSync(path.join(pkg, 'skills/github'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'skills/github/SKILL.md'), '---\nname: github\ndescription: Read github data.\n---\n# GitHub\n');
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'reviewed payload');
  const payloadCommit = git(repo, 'rev-parse', 'HEAD'), pluginInput = path.join(root, 'inputs/plugins');
  fs.mkdirSync(path.dirname(pluginInput), { recursive: true });
  const source = { repository: 'https://github.com/dbalders/TritonAI-Plugins.git', ref: 'refs/tags/v0.1.11', commit: payloadCommit };
  producer.stagePluginsFromSource({ sourceRoot: repo, vendorDir: pluginInput, selectedIds: ['github'], source });
  fs.writeFileSync(path.join(repo, 'verification-only.cjs'), '// local verifier correction\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'verification only');
  const tool = { repo, commit: git(repo, 'rev-parse', 'HEAD') };
  const candidate = { version: '0.3.8', pluginVerificationTool: tool, pluginIds: ['github'], sources: { plugins: { repo, commit: payloadCommit }, skills: { commit: payloadCommit } }, tools: { node: process.execPath }, toolIdentities: {}, notary: { keyFile: '/fixture/key' } };
  const prepared = { dirs: { 'plugins-verifier': repo, 'installer-mac': path.resolve(__dirname, '..'), 'harness-mac': path.join(root, 'harness'), plugins: path.join(root, 'original-payload') },
    pluginInput, commits: { harness: 'a'.repeat(40), installer: 'b'.repeat(40) } };
  const producerFile = path.join(prepared.dirs['harness-mac'], '.github/scripts/prepare-managed-plugins.cjs');
  fs.mkdirSync(path.dirname(producerFile), { recursive: true });
  fs.writeFileSync(producerFile, `const fs = require('node:fs'), path = require('node:path'); module.exports.stagePluginsFromSource = ${stageFixture.toString()};`);
  const harness = prepared.dirs['harness-mac'];
  git(harness, 'init', '-b', 'main'); git(harness, 'config', 'user.name', 'Fixture'); git(harness, 'config', 'user.email', 'fixture@example.invalid');
  git(harness, 'add', '.'); git(harness, 'commit', '-m', 'frozen Harness producer');
  prepared.commits.harness = git(harness, 'rev-parse', 'HEAD');
  for (const name of ['installer-win', 'harness-win', 'skills']) prepared.dirs[name] = path.join(root, name);
  return { root, repo, pkg, tool, candidate, prepared, payloadCommit };
}

test('verifier requires a clean checkout at one explicit full local commit', t => {
  const f = fixture(t);
  assert.deepEqual(validatePluginVerificationTool(f.tool), f.tool);
  for (const value of [null, {}, { repo: 'relative', commit: f.tool.commit }, { ...f.tool, commit: 'main' }, { ...f.tool, extra: true }])
    assert.throws(() => validatePluginVerificationTool(value), /absolute repo and full commit/);
  assert.throws(() => validatePluginVerificationTool({ ...f.tool, commit: f.payloadCommit }), /exact frozen commit/);
  assert.throws(() => validatePluginVerificationTool({ ...f.tool, repo: f.pkg }), /exact frozen commit/);
  fs.writeFileSync(path.join(f.repo, 'untracked'), 'drift');
  assert.throws(() => validatePluginVerificationTool(f.tool), /must be clean/);
});

test('verifier resolves Git root spelling to filesystem identity on Windows', () => {
  const source = fs.readFileSync(path.join(__dirname, 'local-release-plugin-verifier.cjs'), 'utf8');
  const repo = 'C:\\Work\\Repository', gitRoot = 'c:/work/repository', commit = 'a'.repeat(40);
  const calls = [], module = { exports: {} };
  runInNewContext(source, { module, require: name => {
    if (name === 'node:fs') return { realpathSync: value => {
      assert.ok([repo, gitRoot].includes(value));
      return repo;
    } };
    if (name === 'node:path') return path.win32;
    if (name === 'node:child_process') return { execFileSync: (exe, args) => {
      assert.equal(exe, 'git'); assert.deepEqual(Array.from(args.slice(0, 2)), ['-C', repo]);
      const command = Array.from(args.slice(2)); calls.push(command);
      if (command.join(' ') === 'rev-parse --show-toplevel') return gitRoot + '\n';
      if (command.join(' ') === 'rev-parse HEAD') return commit + '\n';
      assert.deepEqual(command, ['status', '--porcelain=v1', '--untracked-files=all']); return '';
    } };
    if (name === 'node:assert/strict') return assert;
    throw new Error(`Unexpected fixture dependency: ${name}`);
  } });
  const result = module.exports.validatePluginVerificationTool({ repo, commit });
  assert.equal(result.repo, repo); assert.equal(result.commit, commit);
  assert.deepEqual(calls, [['rev-parse', '--show-toplevel'], ['rev-parse', 'HEAD'], ['status', '--porcelain=v1', '--untracked-files=all']]);
});

test('resume checks the frozen verifier identity and rejects source drift', async t => {
  const f = fixture(t), candidate = JSON.parse(JSON.stringify(f.candidate));
  await assert.doesNotReject(assertToolIdentities(candidate));
  fs.writeFileSync(path.join(f.repo, 'verification-only.cjs'), '// changed\n');
  await assert.rejects(assertToolIdentities(candidate), /must be clean/);
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'new unselected tool');
  await assert.rejects(assertToolIdentities(candidate), /exact frozen commit/);
});

test('Harness-selected producer proves exact payload parity without changing approved source identity', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.prepared.pluginInput, 'manifest.json'));
  const receipt = verifyPluginVerificationParity(f.candidate, f.prepared, f.root);
  assert.equal(receipt.payloadSource.commit, f.payloadCommit);
  assert.equal(receipt.verificationTool.commit, f.tool.commit);
  assert.equal(receipt.packages[0].id, 'github');
  assert.deepEqual(fs.readFileSync(path.join(f.prepared.pluginInput, 'manifest.json')), before);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'proof')), []);
});

test('Harness-selected producer rejects committed payload drift, changed selection, and source mismatch', t => {
  const f = fixture(t);
  assert.throws(() => verifyPluginVerificationParity({ ...f.candidate, pluginIds: ['other'] }, f.prepared, f.root), /selection differs/);
  assert.throws(() => verifyPluginVerificationParity({ ...f.candidate, sources: { plugins: { commit: 'c'.repeat(40) } } }, f.prepared, f.root), /payload source differs/);
  fs.writeFileSync(path.join(f.pkg, 'README.md'), '# changed packaged bytes\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'payload drift');
  f.candidate.pluginVerificationTool.commit = git(f.repo, 'rev-parse', 'HEAD');
  assert.throws(() => verifyPluginVerificationParity(f.candidate, f.prepared, f.root), /payload differs/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'proof')), []);
});

test('recipe binds verifier source and serializes its full gate after Harness tests', t => {
  const f = fixture(t), file = path.join(f.root, 'candidate.json'); save(file, f.candidate);
  const plan = makeBuildRecipe(file, f.prepared), check = plan.steps.find(s => s.id === 'plugins-checks');
  assert.equal(check.cwd, f.tool.repo); assert.equal(check.commit, f.tool.commit);
  assert.ok(check.needs.includes('harness-checks'));
  assert.ok(check.sources.some(s => s.path === f.tool.repo && s.commit === f.tool.commit));
  assert.ok(check.sources.some(s => s.path === f.prepared.dirs.plugins && s.commit === f.payloadCommit));
});

test('plugins stage runs complete readiness in verifier cwd and records pre/post parity', async t => {
  const f = fixture(t), file = path.join(f.root, 'candidate.json');
  let executions = 0;
  const executeCheck = async (cwd, argv, env) => {
    executions += 1;
    assert.equal(cwd, f.tool.repo);
    assert.deepEqual(argv, ['corepack', 'pnpm', 'readiness:local']);
    assert.equal(env.TRITONAI_HARNESS_ROOT, f.prepared.dirs['harness-mac']);
    assert.equal(env.TRITONAI_HARNESS_COMMIT, f.prepared.commits.harness);
  };
  save(file, f.candidate); save(path.join(f.root, 'prepared.json'), f.prepared);
  await stage('plugins-checks', file, { executeCheck });
  assert.equal(executions, 1);
  const proof = JSON.parse(fs.readFileSync(path.join(f.root, 'proof/plugins-checks.json')));
  assert.equal(proof.sources.plugins.commit, f.payloadCommit); assert.equal(proof.verificationTool.commit, f.tool.commit);
  assert.equal(proof.parity.before.packages[0].digest, proof.parity.after.packages[0].digest);
  fs.rmSync(path.join(f.root, 'proof/plugins-checks.json'));
  await assert.rejects(stage('plugins-checks', file, { executeCheck: async (...args) => {
    await executeCheck(...args);
    fs.writeFileSync(path.join(f.pkg, 'README.md'), 'mutated during gate');
  } }), /must be clean/);
  assert.equal(executions, 2);
  assert.ok(!fs.existsSync(path.join(f.root, 'proof/plugins-checks.json')));
  // A dirty verifier must fail before the readiness command can run.
  await assert.rejects(stage('plugins-checks', file, { executeCheck }), /must be clean/);
  assert.equal(executions, 2);
  git(f.repo, 'restore', '--', 'plugins/github/README.md');
  await assert.rejects(stage('plugins-checks', file, { executeCheck: async (...args) => {
    await executeCheck(...args); throw new Error('controlled readiness failure');
  } }), /controlled readiness failure/);
  assert.equal(executions, 3);
  assert.ok(!fs.existsSync(path.join(f.root, 'proof/plugins-checks.json')));
});


test('explicit Windows selection omits Mac assembly while preserving all source gates', t => {
  const f = fixture(t), file = path.join(f.root, 'candidate.json');
  save(file, { ...f.candidate, platforms: ['win'] });
  const plan = makeBuildRecipe(file, f.prepared);
  for (const id of ['validate-inputs', 'harness-checks', 'installer-checks', 'plugins-checks', 'harness-win', 'installer-win']) assert.ok(plan.steps.some(s => s.id === id));
  assert.ok(!plan.steps.some(s => ['harness-mac', 'installer-mac'].includes(s.id)));
  assert.deepEqual(plan.steps.find(s => s.id === 'handoff').needs, ['installer-win']);
  const { buildPlatforms } = require('./local-release-stages.cjs');
  for (const platforms of [[], ['win', 'win'], ['linux']]) assert.throws(() => buildPlatforms({ platforms }), /select mac and\/or win/);
});
