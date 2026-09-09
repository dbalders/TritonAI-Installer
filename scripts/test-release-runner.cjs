const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, validate } = require('./release-runner.cjs');
const { collect } = require('./collect-release-artifacts.cjs');
const { wait } = require('./wait-harness-release.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const step = id => { const cwd = path.join(root, id); fs.mkdirSync(cwd); return { id, cwd, git: false, commands: [[process.execPath, '-e', "require('fs').writeFileSync('artifact', 'verified')"]], outputs: ['artifact'] }; };
  return { root, step, state: path.join(root, 'state') };
}
test('executes real child, verifies receipt, and skips completed work on retry', async t => {
  const f = fixture(t), step = f.step('package');
  const plan = { schemaVersion: 1, steps: [step] };
  await run(plan, f.state);
  await run(plan, f.state, { executeCommand: () => { throw new Error('must not rebuild'); } });
  fs.writeFileSync(path.join(step.cwd, 'artifact'), 'changed');
  await assert.rejects(run(plan, f.state), /Completed stage changed/);
});
test('retries failure without repeating completed dependencies; does not launch downstream', async t => {
  const f = fixture(t), a = f.step('a'), b = { ...f.step('b'), needs: ['a'] }, c = { ...f.step('c'), needs: ['b'] };
  const plan = { schemaVersion: 1, steps: [a, b, c] }, counts = {};
  let fail = true;
  const executeCommand = async (_, step) => {
    counts[step.id] = (counts[step.id] || 0) + 1;
    if (step.id === 'b' && fail) throw new Error('upload failed');
    fs.writeFileSync(path.join(step.cwd, 'artifact'), 'ok');
  };
  await assert.rejects(run(plan, f.state, { executeCommand }), /upload failed/);
  assert.equal(counts.c, undefined);
  fail = false; await run(plan, f.state, { executeCommand });
  assert.deepEqual(counts, { a: 1, b: 2, c: 1 });
});
test('overlaps independent work and waits for running work before reporting a failure', async t => {
  const f = fixture(t), a = f.step('a'), b = f.step('b');
  let releaseA; const waiting = new Promise(resolve => { releaseA = resolve; });
  let finished = false;
  await assert.rejects(run({ schemaVersion: 1, steps: [a, b] }, f.state, { executeCommand: async (_, step) => {
    if (step.id === 'a') { await waiting; fs.writeFileSync(path.join(a.cwd, 'artifact'), 'ok'); finished = true; }
    else { releaseA(); throw new Error('failure'); }
  } }), /failure/);
  assert.ok(finished);
});
test('shared build resources serialize commands', async t => {
  const f = fixture(t), a = f.step('a'), b = f.step('b');
  a.resources = b.resources = ['nsis']; let active = false;
  await run({ schemaVersion: 1, steps: [a, b] }, f.state, { executeCommand: async (_, step) => {
    assert.equal(active, false); active = true;
    await Promise.resolve(); fs.writeFileSync(path.join(step.cwd, 'artifact'), 'ok'); active = false;
  } });
});
test('changed input, environment, and recipe invalidate cached results', async t => {
  const f = fixture(t), step = f.step('a');
  const input = path.join(f.root, 'input'); fs.writeFileSync(input, 'v1'); step.inputs = [input];
  const plan = { schemaVersion: 1, steps: [step] }; await run(plan, f.state);
  fs.writeFileSync(input, 'v2'); await assert.rejects(run(plan, f.state), /Completed stage changed/);
  plan.steps[0].commands[0].push('changed'); await assert.rejects(run(plan, f.state), /Recipe changed/);
});
test('dry run performs no commands or state writes; invalid recipes fail early', async t => {
  const f = fixture(t), a = f.step('a');
  await run({ schemaVersion: 1, steps: [a] }, f.state, { dryRun: true }); assert.equal(fs.existsSync(f.state), false);
  assert.throws(() => validate({ schemaVersion: 1, steps: [{ ...a, needs: ['a'] }] }), /cycle/);
  assert.throws(() => validate({ schemaVersion: 1, steps: [a, a] }), /duplicate/);
  assert.throws(() => validate({ schemaVersion: 1, steps: [{ ...a, needs: ['missing'] }] }), /Unknown/);
});
test('lock blocks concurrent runners and malformed state releases the lock', async t => {
  const f = fixture(t), plan = { schemaVersion: 1, steps: [f.step('a')] };
  fs.mkdirSync(f.state); fs.writeFileSync(path.join(f.state, 'runner.lock'), '1');
  await assert.rejects(run(plan, f.state), /locked/); fs.unlinkSync(path.join(f.state, 'runner.lock'));
  fs.writeFileSync(path.join(f.state, 'state.json'), '{'); await assert.rejects(run(plan, f.state));
  assert.equal(fs.existsSync(path.join(f.state, 'runner.lock')), false);
});
test('handoff preserves exact bytes, resumes, and refuses replacement', async t => {
  const f = fixture(t), source = path.join(f.root, 'artifact'), destination = path.join(f.root, 'handoff', 'artifact');
  fs.writeFileSync(source, 'verified'); await collect([{ source, destination }]); await collect([{ source, destination }]);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'verified'); fs.writeFileSync(source, 'replacement');
  await assert.rejects(collect([{ source, destination }]), /different bytes/);
});
test('CI wait rejects unrelated workflows and reads back success', () => {
  const commit = 'a'.repeat(40); let calls = 0;
  wait('123', commit, (...args) => {
    calls++; if (args[0] === 'run') { assert.ok(args.includes('--exit-status')); return ''; }
    return JSON.stringify({ head_sha: commit, path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success' });
  }); assert.equal(calls, 3);
  assert.throws(() => wait('123', commit, () => JSON.stringify({ head_sha: 'b'.repeat(40) })), /does not match/);
});
test('preparer creates same-commit isolated worktrees and gates both packages on tests', async t => {
  const { execFileSync } = require('node:child_process');
  const { prepare } = require('./prepare-release-run.cjs');
  const f = fixture(t);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function repo(name) {
    const cwd = path.join(f.root, name); fs.mkdirSync(cwd); git(cwd, 'init');
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"version":"0.3.4"}');
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
    return cwd;
  }
  const root = repo('installer'), plugins = repo('plugins'), skills = repo('skills');
  git(plugins, 'tag', 'v1.0.0'); const assets = path.join(f.root, 'assets'); fs.mkdirSync(assets);
  for (const file of ['TritonAI-Harness-0.3.4-arm64.dmg', 'latest-mac.yml', 'tritonai-plugin-composition-mac-arm64.json', 'TritonAI-Harness-0.3.4-x64.exe', 'latest.yml', 'tritonai-plugin-composition-win-x64.json']) fs.writeFileSync(path.join(assets, file), 'fixture');
  const directory = path.join(f.root, 'candidate');
  const keyFile = path.join(f.root, 'test-key.p8'); fs.writeFileSync(keyFile, 'fixture-key');
  const env = { APPLE_API_KEY: keyFile, APPLE_API_KEY_ID: 'test', APPLE_API_ISSUER: 'test', TRITONAI_HARNESS_VERSION: '0.3.4', TRITONAI_PLUGINS_SOURCE: plugins, TRITONAI_PLUGINS_REF: 'refs/tags/v1.0.0', TRITONAI_PLUGINS_COMMIT: git(plugins, 'rev-parse', 'HEAD'), UCSD_SKILLS_SOURCE: skills, TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE: '1', RELEASE_HARNESS_ASSETS: assets };
  const recipe = JSON.parse(fs.readFileSync(await prepare(directory, env, root)));
  assert.equal(git(path.join(directory, 'mac'), 'rev-parse', 'HEAD'), git(path.join(directory, 'win'), 'rev-parse', 'HEAD'));
  assert.equal(recipe.steps.filter(s => s.id.endsWith('-tests')).length, 1);
  for (const step of recipe.steps.filter(s => s.id.endsWith('-package'))) {
    assert.ok(step.needs.includes('mac-tests'));
    assert.equal(step.env.TRITONAI_HARNESS_RELEASE_BASE, require('node:url').pathToFileURL(assets).href);
    assert.ok(step.resources.includes('electron-builder-release-cache'));
  }
  assert.equal(recipe.steps.at(-1).id, 'handoff');
  await assert.rejects(prepare(directory, env, root), /already exists/);
  await assert.rejects(prepare(path.join(f.root, 'bad'), { ...env, TRITONAI_PLUGINS_COMMIT: '0'.repeat(40) }, root), /commit pin/);
  const packages = recipe.steps.filter(s => s.id.endsWith('-package'));
  assert.deepEqual(packages[0].inputs[0], packages[1].inputs[0]);
  assert.equal(packages[0].inputs[0].sha256, await require('./release-runner.cjs').treeHash(assets));
  const failed = path.join(f.root, 'failed');
  await assert.rejects(prepare(failed, env, root, { git: (cwd, ...args) => {
    if (args[0] === 'worktree' && args[1] === 'add' && args.includes(path.join(failed, 'win'))) throw new Error('second worktree failed');
    return git(cwd, ...args);
  } }), /second worktree failed/);
  assert.equal(fs.existsSync(failed), false);
  assert.equal(git(root, 'worktree', 'list', '--porcelain').includes(failed), false);
  await assert.rejects(prepare(failed, env, root, { writeRecipe: file => { fs.writeFileSync(file, '{partial'); throw new Error('recipe write failed'); } }), /recipe write failed/);
  assert.equal(fs.existsSync(failed), false);
  assert.equal(git(root, 'worktree', 'list', '--porcelain').includes(failed), false);
  assert.ok(fs.existsSync(await prepare(failed, env, root)));

});
test('changed release environment invalidates receipts without persisting its value', async t => {
  const f = fixture(t), step = f.step('a'), key = 'TRITONAI_RUNNER_TEST_SECRET';
  const old = process.env[key]; t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  process.env[key] = 'secret-first-value'; step.requiredEnv = [key];
  const plan = { schemaVersion: 1, steps: [step] }; await run(plan, f.state);
  assert.equal(fs.readFileSync(path.join(f.state, 'state.json'), 'utf8').includes('secret-first-value'), false);
  process.env[key] = 'changed'; await assert.rejects(run(plan, f.state), /changed/);
});
test('prepared inputs reject changes before first use and between platform stages', async t => {
  const { treeHash } = require('./release-runner.cjs');
  const f = fixture(t), input = path.join(f.root, 'harness'); fs.writeFileSync(input, 'verified');
  const expected = await treeHash(input);
  const a = { ...f.step('mac'), inputs: [{ path: input, sha256: expected }] };
  const b = { ...f.step('win'), needs: ['mac'], inputs: [{ path: input, sha256: expected }] };
  let executions = 0;
  fs.writeFileSync(input, 'replaced-before-first-use');
  await assert.rejects(run({ schemaVersion: 1, steps: [a] }, f.state, { executeCommand: () => { executions++; } }), /prepared hash/);
  assert.equal(executions, 0);
  fs.writeFileSync(input, 'verified');
  await run({ schemaVersion: 1, steps: [a] }, f.state);
  // A new stage has no prior receipt: it must still use the prepared hash.
  fs.writeFileSync(input, 'replaced-between-platforms');
  await assert.rejects(run({ schemaVersion: 1, steps: [{ ...b, needs: [] }] }, path.join(f.root, 'second-state'), { executeCommand: () => { executions++; } }), /prepared hash/);
  assert.equal(executions, 0);
});
test('Mac credential file changes invalidate the prepared inputs', async t => {
  const { macCredentialInputs } = require('./prepare-release-run.cjs');
  const f = fixture(t), configDir = path.join(f.root, '.agents', 'secrets', 'appstore'); fs.mkdirSync(configDir, { recursive: true });
  const config = path.join(configDir, 'config.json'), key = path.join(configDir, 'key.p8');
  fs.writeFileSync(key, 'test-private-key'); fs.writeFileSync(config, JSON.stringify({ keyId: 'test', issuerId: 'test', keyFile: 'key.p8' }));
  const inputs = await macCredentialInputs({}, f.root); assert.equal(inputs.length, 2);
  const step = { ...f.step('package'), inputs };
  fs.writeFileSync(key, 'rotated-test-private-key');
  await assert.rejects(run({ schemaVersion: 1, steps: [step] }, f.state), /prepared hash/);
  const explicit = await macCredentialInputs({ APPLE_API_KEY: key, APPLE_API_KEY_ID: 'test', APPLE_API_ISSUER: 'test' }, f.root);
  assert.equal(explicit.length, 1);
});
test('optional recipe fields fail validation before any work begins', t => {
  const f = fixture(t), step = f.step('a');
  for (const [field, value] of [['needs', 'a'], ['resources', 'cache'], ['inputs', [{}]], ['sources', [{}]], ['env', []], ['requiredEnv', 'NAME']]) {
    assert.throws(() => validate({ schemaVersion: 1, steps: [{ ...step, [field]: value }] }), new RegExp(`Invalid ${field}`));
  }
});
