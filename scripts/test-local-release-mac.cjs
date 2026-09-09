'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { findKeptStage, getNotaryConfig, verifyPluginPayload, isolatedBootEnvironment,
  withMountedDmg, verifyPackagedBoot, finalizeMacRelease } = require('./local-release-mac.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-mac-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'stage');
  const stageApp = path.join(stageRoot, 't3code-desktop-mac-stage-fixture', 'app');
  const app = path.join(root, 'TritonAI Harness.app');
  const release = path.join(root, 'custom-output');
  fs.mkdirSync(stageApp, { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), 'fixture-archive');
  fs.writeFileSync(path.join(stageApp, 'package.json'), JSON.stringify({ version: '0.3.4', t3codeCommitHash: 'b'.repeat(12), build: { productName: 'TritonAI Harness' } }));
  const bytes = Buffer.from('plugin implementation');
  const file = { path: 'index.js', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const digest = crypto.createHash('sha256').update(file.path).update('\0').update(String(file.size)).update('\0').update(bytes).update('\0').digest('hex');
  const composition = { version: 1, kind: 'tritonai-harness-plugin-composition', source: {
    repository: 'https://github.com/dbalders/TritonAI-Plugins.git', ref: 'refs/tags/v0.1.0', commit: 'a'.repeat(40),
  }, packages: [{ id: 'github', name: '@tritonai/plugin-github', version: '0.1.0', digest, files: [file] }] };
  const pluginsPath = 'apps/server/dist/production-integrations';
  const entries = {
    'package.json': Buffer.from(JSON.stringify({ version: '0.3.4' })),
    'apps/server/dist/bin.mjs': Buffer.from('github production-integrations tritonai-harness-plugin-composition'),
    [`${pluginsPath}/manifest.json`]: Buffer.from(JSON.stringify(composition)),
    [`${pluginsPath}/packages/github/index.js`]: bytes,
  };
  const asar = {
    extractFile: (_archive, entry) => { assert(entries[entry], `Missing entry ${entry}`); return entries[entry]; },
    listPackage: () => Object.keys(entries).map((entry) => `/${entry}`),
    statFile: (_archive, entry) => ({ size: entries[entry].length }),
  };
  const snapshot = path.join(path.dirname(stageApp), 'plugin-composition-input');
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, 'manifest.json'), JSON.stringify(composition));
  fs.writeFileSync(path.join(release, '.tritonai-plugin-composition-mac-arm64.json.input'), JSON.stringify(composition));
  const key = path.join(root, 'AuthKey.p8');
  fs.writeFileSync(key, 'test-key');
  const env = { DEVELOPER_ID_APPLICATION: 'Developer ID Application: Fixture (TEAM)', APPLE_API_KEY: key, APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER' };
  return { root, stageRoot, stageApp, app, release, composition, entries, asar, env };
}

test('selects only the unique exact candidate stage with matching version', (t) => {
  const f = fixture(t);
  assert.equal(findKeptStage(f.stageRoot, '0.3.4'), f.stageApp);
  assert.throws(() => findKeptStage(f.stageRoot, '0.3.5'), /version\/product/);
  fs.mkdirSync(path.join(f.stageRoot, 't3code-desktop-mac-stage-old'));
  assert.throws(() => findKeptStage(f.stageRoot, '0.3.4'), /found 2/);
});

test('resolves partial notary overrides without including key bytes', (t) => {
  const f = fixture(t);
  const config = path.join(f.root, 'notary.json');
  fs.writeFileSync(config, JSON.stringify({ keyFile: 'AuthKey.p8', keyId: 'OLD', issuerId: 'ISSUER' }));
  assert.deepEqual(getNotaryConfig({ APPLE_API_KEY_ID: 'NEW' }, config), { key: f.env.APPLE_API_KEY, keyId: 'NEW', issuer: 'ISSUER' });
  assert.throws(() => getNotaryConfig({}, path.join(f.root, 'absent')), /Set APPLE_API_KEY/);
});

test('checks actual ASAR bytes, inventories and package digests against the frozen selection', (t) => {
  const f = fixture(t);
  assert.equal(verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4').fileCount, 1);
  const pluginFile = 'apps/server/dist/production-integrations/packages/github/index.js';
  f.entries[pluginFile] = Buffer.from('corrupted implementation');
  assert.throws(() => verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4'), /bytes differ/);
});

test('rejects unlisted packaged plugin files and different manifests', (t) => {
  const f = fixture(t);
  f.entries['apps/server/dist/production-integrations/packages/github/unlisted.js'] = Buffer.from('extra');
  assert.throws(() => verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4'), /unlisted or missing/);
  delete f.entries['apps/server/dist/production-integrations/packages/github/unlisted.js'];
  f.entries['apps/server/dist/production-integrations/manifest.json'] = Buffer.from('{}');
  assert.throws(() => verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4'), /manifest differs/);
});

test('boot environment isolates all user state and excludes ambient credentials', () => {
  const environment = isolatedBootEnvironment('/tmp/candidate-home', {
    HOME: '/Users/live', PATH: '/usr/bin', OPENAI_API_KEY: 'secret', GH_TOKEN: 'secret',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require unsafe', TRITONAI_HOME: '/Users/live/.tritonai-harness',
  });
  assert.equal(environment.HOME, '/tmp/candidate-home');
  assert.equal(environment.TRITONAI_HOME, '/tmp/candidate-home/harness-state');
  assert.equal(environment.PATH, '/usr/bin');
  for (const key of ['OPENAI_API_KEY', 'GH_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) assert.equal(environment[key], undefined);
});

test('retains an attached mountpoint on failed detach', async (t) => {
  const f = fixture(t);
  let mount;
  await assert.rejects(withMountedDmg('fixture.dmg', f.stageRoot, (_command, args) => {
    if (args[0] === 'attach') mount = args.at(-1);
    if (args[0] === 'detach') throw new Error('detach failed');
  }, () => undefined), /detach failed/);
  assert(fs.existsSync(mount), 'mounted volume must not be recursively removed');
});

function bootMocks(f, { unsafeUserData = false } = {}) {
  let launchOptions;
  let closed = false;
  const page = { url: () => 't3code://app/', evaluate: async () => true };
  const application = {
    process: () => ({ pid: 100, exitCode: 0 }),
    evaluate: async (_callback, argument) => argument ? true : {
      version: '0.3.4', packaged: true,
      userData: unsafeUserData ? '/Users/live/Library/Application Support/tritonai-harness' : path.join(launchOptions.env.HOME, 'Library', 'Application Support', 'tritonai-harness'),
      windows: [{ visible: true, rendererPid: 300, url: page.url() }],
    },
    windows: () => [page], close: async () => { closed = true; },
  };
  return {
    electron: { launch: async (options) => { launchOptions = options; return application; } },
    runCommand: (command, args) => {
      if (command.endsWith('ditto')) fs.cpSync(args.at(-2), args.at(-1), { recursive: true });
      return { stdout: command.endsWith('lsof') ? 'p200\n' : '100\n' };
    },
    wait: async () => {}, selectPort: async () => 43123, assertAlive: () => {},
    fetchResponse: async (url) => { assert.equal(url, 'http://127.0.0.1:43123/.well-known/t3/environment'); return { ok: true }; },
    getState: () => ({ launchOptions, closed }),
  };
}

test('boot gate verifies the custom-protocol renderer and an owned backend in isolated HOME', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f);
  const result = await verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env, ...mock });
  assert.equal(result.backendPid, 200);
  assert.equal(result.healthyForMs, 5000);
  assert.equal(mock.getState().launchOptions.env.T3CODE_PORT, '43123');
  assert.equal(mock.getState().closed, true);
  assert(!fs.existsSync(mock.getState().launchOptions.env.HOME));
});

test('boot gate fails closed if Electron resolves the live user-data directory', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { unsafeUserData: true });
  await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env, ...mock }), /isolated candidate/);
  assert.equal(mock.getState().closed, true);
});

function packagingMocks(f, status = 'Accepted') {
  const calls = [];
  const signedApp = path.join(f.stageApp, 'dist', 'mac-arm64', 'TritonAI Harness.app');
  const command = (program, args, options = {}) => {
    calls.push({ program, args, options });
    if (program === 'git') return { stdout: 'b'.repeat(40) };
    if (program === 'codesign' && args[0] === '--display') return { stderr: 'Authority=Developer ID Application: Fixture (TEAM)\n' };
    if (program === 'vp') {
      fs.cpSync(f.app, signedApp, { recursive: true });
      fs.writeFileSync(path.join(f.stageApp, 'dist', 'TritonAI-Harness-0.3.4-arm64.zip'), 'zip');
      fs.writeFileSync(path.join(f.stageApp, 'dist', 'TritonAI-Harness-0.3.4-arm64.zip.blockmap'), 'zip-blockmap');
    }
    if (program.endsWith('ditto')) {
      const target = args[0] === '-x' ? path.join(args.at(-1), 'TritonAI Harness.app') : args.at(-1);
      fs.cpSync(args[0] === '-x' ? signedApp : args.at(-2), target, { recursive: true });
    }
    if (program === 'hdiutil') {
      if (args[0] === 'create' || args[0] === 'convert') fs.writeFileSync(args.at(-1), 'dmg');
      if (args[0] === 'attach' && args.includes('-readonly')) fs.cpSync(signedApp, path.join(args.at(-1), 'TritonAI Harness.app'), { recursive: true });
    }
    if (program === 'xcrun' && args[0] === 'notarytool') return { stdout: JSON.stringify({ status, id: 'notary-job' }) };
    if (program === 'xcrun' && args[1] === 'staple') fs.appendFileSync(args[2], '-stapled');
    if (program === process.execPath) {
      const dmg = args[args.indexOf('--artifact') + 1];
      const bytes = fs.readFileSync(dmg);
      fs.writeFileSync(path.join(f.release, 'tritonai-plugin-composition-mac-arm64.json'), JSON.stringify({ ...f.composition, artifacts: [{ fileName: path.basename(dmg), size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') }] }));
    }
    return { stdout: '' };
  };
  return { calls, command, tools: { asar: f.asar, buildBlockMap: async (input, format, output) => {
    assert.equal(format, 'gzip');
    assert.match(fs.readFileSync(input, 'utf8'), /-stapled$/);
    fs.writeFileSync(output, 'final-blockmap');
  } } };
}

test('full finalization binds metadata after stapling, verifies payload and boot, and uses explicit output', async (t) => {
  const f = fixture(t);
  const mock = packagingMocks(f);
  let bootVerified = false;
  const report = await finalizeMacRelease({ harnessRoot: f.root, stageRoot: f.stageRoot, version: '0.3.4', outputDir: f.release,
    env: f.env, platform: 'darwin', runCommand: mock.command, packagingTools: mock.tools,
    verifyBoot: async ({ appPath }) => { assert(fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app.asar'))); bootVerified = true; return { healthyForMs: 5000 }; },
  });
  assert(bootVerified);
  assert.equal(report.notarization.status, 'Accepted');
  assert(fs.existsSync(path.join(f.release, 'harness-mac-verification.json')));
  assert.match(fs.readFileSync(path.join(f.release, 'latest-mac.yml'), 'utf8'), new RegExp(`size: ${'dmg-stapled'.length}`));
  const signing = mock.calls.find((call) => call.program === 'vp');
  assert.equal(signing.options.env.CSC_NAME, 'Fixture (TEAM)');
  assert.equal(signing.options.env.APPLE_API_KEY, undefined);
  const finalizer = mock.calls.find((call) => call.program === process.execPath);
  assert.equal(finalizer.args.at(-1), f.release);
});

test('rejected notarization cannot emit successful proof or updater metadata', async (t) => {
  const f = fixture(t);
  const mock = packagingMocks(f, 'Invalid');
  await assert.rejects(finalizeMacRelease({ harnessRoot: f.root, stageRoot: f.stageRoot, version: '0.3.4', outputDir: f.release,
    env: f.env, platform: 'darwin', runCommand: mock.command, packagingTools: mock.tools }), /did not accept/);
  assert(!fs.existsSync(path.join(f.release, 'harness-mac-verification.json')));
  assert(!mock.calls.some((call) => call.program === process.execPath));
});
