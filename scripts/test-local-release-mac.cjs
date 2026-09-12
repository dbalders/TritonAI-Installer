'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { failureExitCode } = require('./local-release.cjs');
const { macReleaseIdentity, findKeptStage, getNotaryConfig, verifyPluginPayload, isolatedBootEnvironment,
  withMountedDmg, verifyPackagedBoot, finalizeMacRelease, processSnapshot, trackBootProcesses } = require('./local-release-mac.cjs');

function fixture(t, version = '0.3.4') {
  const { productName } = macReleaseIdentity(version);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-mac-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'stage');
  const stageApp = path.join(stageRoot, 't3code-desktop-mac-stage-fixture', 'app');
  const app = path.join(root, `${productName}.app`);
  const release = path.join(root, 'custom-output');
  fs.mkdirSync(stageApp, { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({packageManager: 'pnpm@11.10.0'}));
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), 'fixture-archive');
  fs.writeFileSync(path.join(stageApp, 'package.json'), JSON.stringify({ version, t3codeCommitHash: 'b'.repeat(12), build: { productName, mac: { target: ['zip'] } } }));
  const bytes = Buffer.from('plugin implementation');
  const file = { path: 'index.js', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const digest = crypto.createHash('sha256').update(file.path).update('\0').update(String(file.size)).update('\0').update(bytes).update('\0').digest('hex');
  const composition = { version: 1, kind: 'tritonai-harness-plugin-composition', source: {
    repository: 'https://github.com/dbalders/TritonAI-Plugins.git', ref: 'refs/tags/v0.1.0', commit: 'a'.repeat(40),
  }, packages: [{ id: 'github', name: '@tritonai/plugin-github', version: '0.1.0', digest, files: [file] }] };
  const pluginsPath = 'apps/server/dist/production-integrations';
  const entries = {
    'package.json': Buffer.from(JSON.stringify({ version })),
    'apps/server/dist/bin.mjs': Buffer.from('github production-integrations tritonai-harness-plugin-composition'),
    [`${pluginsPath}/packages/github/index.js`]: bytes,
  };
  const archivePaths = () => {
    const names = new Set(Object.keys(entries));
    for (const name of Object.keys(entries)) {
      for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) names.add(parent);
    }
    return [...names];
  };
  const asar = {
    extractFile: (_archive, entry) => {
      entry = entry.replaceAll('\\', '/');
      assert(entries[entry], `Missing entry ${entry}`);
      return entries[entry];
    },
    listPackage: () => archivePaths().map((entry) => `/${entry}`),
    statFile: (_archive, entry) => {
      entry = entry.replaceAll('\\', '/');
      assert(archivePaths().includes(entry), `Missing entry ${entry}`);
      return entries[entry] ? { size: entries[entry].length } : { files: {} };
    },
  };
  const snapshot = path.join(path.dirname(stageApp), 'plugin-composition-input');
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, 'manifest.json'), JSON.stringify(composition));
  fs.writeFileSync(path.join(release, '.tritonai-plugin-composition-mac-arm64.json.input'), JSON.stringify(composition));
  const key = path.join(root, 'AuthKey.p8');
  fs.writeFileSync(key, 'test-key');
  const env = { DEVELOPER_ID_APPLICATION: 'Developer ID Application: Fixture (TEAM)', APPLE_API_KEY: key, APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER' };
  return { version, productName, root, stageRoot, stageApp, app, release, composition, entries, asar, env };
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

test('checks ASAR plugin bytes against the external proof without requiring an embedded manifest', (t) => {
  const f = fixture(t);
  assert.equal(verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4').fileCount, 1);
  const pluginFile = 'apps/server/dist/production-integrations/packages/github/index.js';
  f.entries[pluginFile] = Buffer.from('corrupted implementation');
  assert.throws(() => verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4'), /file differs/);
});

test('rejects unlisted packaged plugin files and different manifests', (t) => {
  const f = fixture(t);
  f.entries['apps/server/dist/production-integrations/packages/github/unlisted.js'] = Buffer.from('extra');
  assert.throws(() => verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4'), /Unexpected packaged plugin entry/);
  delete f.entries['apps/server/dist/production-integrations/packages/github/unlisted.js'];
  f.entries['apps/server/dist/production-integrations/manifest.json'] = Buffer.from(JSON.stringify(f.composition));
  assert.equal(verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4').fileCount, 1);
  f.entries['apps/server/dist/production-integrations/manifest.json'] = Buffer.from('{}');
  assert.throws(() => verifyPluginPayload(f.app, f.composition, f.asar, '0.3.4'), /manifest differs/);
});

test('boot environment isolates all user state and excludes ambient credentials', () => {
  const environment = isolatedBootEnvironment('/tmp/candidate-home', {
    HOME: '/Users/live', PATH: '/usr/bin', OPENAI_API_KEY: 'secret', GH_TOKEN: 'secret',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require unsafe', TRITONAI_HOME: '/Users/live/.tritonai-harness',
  });
  assert.equal(environment.HOME, '/tmp/candidate-home');
  assert.equal(environment.TRITONAI_HOME, path.join('/tmp/candidate-home', 'harness-state'));
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

test('process snapshots parse explicit PID ancestry, group and start time fields without matching names', () => {
  const records = processSnapshot((command, args, options) => {
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=']);
    assert.equal(options.timeout, 2000);
    return { stdout: '  100 50 100 Ss Wed Sep  9 16:00:00 2026\n  200 100 200 S Wed Sep  9 16:00:01 2026\n' };
  });
  assert.deepEqual(records[1], { pid: 200, ppid: 100, pgid: 200, status: 'S', started: 'Wed Sep 9 16:00:01 2026' });
  assert.throws(() => processSnapshot(() => ({ stdout: 'not a process record' })), /ownership snapshot/);
});

test('macOS process fixture freezes and discovers a detached child spawned during cleanup',
  { skip: process.platform !== 'darwin', timeout: 10_000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-process-test-'));
    const control = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const lateReceipt = path.join(root, 'late-child.json');
    const source = `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.once('spawn', () => process.send({ descendantPid: child.pid }));
      process.once('message', () => {
        const late = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        late.once('spawn', () => require('node:fs').writeFileSync(${JSON.stringify(lateReceipt)}, JSON.stringify({ pid: late.pid })));
      });
      setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const read = () => processSnapshot((command, args) => ({ stdout: execFileSync(command, args, { encoding: 'utf8', timeout: 2000 }) }));
    const killed = [];
    let requestedLateChild = false;
    const tracker = trackBootProcesses(parent, read, (pgid, signal) => {
      if (signal === 'SIGSTOP' && pgid === parent.pid && !requestedLateChild) {
        requestedLateChild = true;
        parent.send('fork-before-freeze');
        const deadline = Date.now() + 2000;
        while (!fs.existsSync(lateReceipt)) {
          if (Date.now() >= deadline) throw new Error('Late detached child fixture did not become ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      if (signal === 'SIGKILL') killed.push(pgid);
      process.kill(-pgid, signal);
    }, path.join(root, 'owned-processes.json'));
    t.after(async () => {
      try { tracker.forceStop(); await tracker.waitForExit(3000); }
      finally {
        if (control.exitCode === null && control.signalCode === null) control.kill('SIGKILL');
        if (tracker.stopped) fs.rmSync(root, { recursive: true, force: true });
      }
    });
    let timer;
    const { descendantPid } = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned process fixture did not become ready')), 3000);
      parent.once('message', resolve);
      parent.once('error', reject);
    }).finally(() => clearTimeout(timer));
    const owned = tracker.capture();
    assert(owned.some(p => p.pid === descendantPid && p.ppid === parent.pid && p.pgid === descendantPid));
    assert(!owned.some(p => p.pid === control.pid));
    tracker.forceStop();
    await tracker.waitForExit(3000);
    const latePid = JSON.parse(fs.readFileSync(lateReceipt)).pid;
    assert.deepEqual(new Set(killed), new Set([descendantPid, latePid, parent.pid]));
    assert.equal(killed.at(-1), parent.pid);
    assert(JSON.parse(fs.readFileSync(path.join(root, 'owned-processes.json'))).some(p => p.pid === latePid));
    assert.equal(control.exitCode, null);
    assert.equal(control.signalCode, null);
    process.kill(control.pid, 0);
  });

function bootMocks(f, { unsafeUserData = false, hungEvaluation = false, hungClose = false, stuckBackend = false, reusedBackend = false, forkDuringCleanup = false, closeSignal } = {}) {
  let launchOptions;
  let closed = false;
  const child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null });
  const signals = new EventEmitter();
  const killedGroups = [];
  const signaledGroups = [];
  let processes = [
    { pid: 100, ppid: 50, pgid: 100, status: 'S', started: 'Wed Sep 9 16:00:00 2026' },
    { pid: 200, ppid: 100, pgid: 200, status: 'S', started: 'Wed Sep 9 16:00:01 2026' },
    { pid: 201, ppid: 200, pgid: 200, status: 'S', started: 'Wed Sep 9 16:00:02 2026' },
    { pid: 300, ppid: 100, pgid: 100, status: 'S', started: 'Wed Sep 9 16:00:02 2026' },
    { pid: 900, ppid: 50, pgid: 900, status: 'S', started: 'Wed Sep 9 16:00:00 2026' },
  ];
  const page = { url: () => 't3code://app/', evaluate: async () => true };
  const application = {
    process: () => child,
    evaluate: async (_callback, argument) => hungEvaluation ? new Promise(() => {}) : argument ? true : {
      version: '0.3.4', packaged: true,
      userData: unsafeUserData ? '/Users/live/Library/Application Support/tritonai-harness' : path.join(launchOptions.env.HOME, 'Library', 'Application Support', 'tritonai-harness'),
      windows: [{ visible: true, rendererPid: 300, url: page.url() }],
    },
    windows: () => [page], close: async () => {
      closed = true;
      if (closeSignal) signals.emit(closeSignal);
      if (reusedBackend) processes = processes.filter(p => p.pid !== 201).map(p => p.pid === 200 ? { ...p, ppid: 1, started: 'Wed Sep 9 16:05:00 2026' } : p);
      if (hungClose) return new Promise(() => {});
      processes = processes.filter(p => p.pid === 900);
      child.exitCode = 0;
      child.emit('exit', 0);
    },
  };
  return {
    electron: { launch: async (options) => { launchOptions = options; return application; } },
    runCommand: (command, args) => {
      if (command.endsWith('ditto')) fs.cpSync(args.at(-2), args.at(-1), { recursive: true });
      return { stdout: command.endsWith('lsof') ? 'p200\n' : '100\n' };
    },
    wait: async () => {}, selectPort: async () => 43123, assertAlive: () => {},
    fetchResponse: async (url) => { assert.equal(url, 'http://127.0.0.1:43123/.well-known/t3/environment'); return { ok: true }; },
    readProcessSnapshot: () => structuredClone(processes),
    killGroup: (pid, signal) => {
      assert([100, 200, 400, 500].includes(pid), 'must never signal an unrelated process group');
      signaledGroups.push([pid, signal]);
      if (signal === 'SIGSTOP') {
        // Simulate a detached fork after the snapshot, just before its parent
        // receives SIGSTOP. The new group must be found on the next pass.
        if (forkDuringCleanup && [200, 400].includes(pid)) {
          const next = pid === 200 ? 400 : 500;
          if (!processes.some(p => p.pid === next)) processes.push({ pid: next, ppid: pid, pgid: next, status: 'S', started: `Wed Sep 9 16:00:0${next / 100} 2026` });
        }
        processes = processes.map(p => p.pgid === pid ? { ...p, status: 'T' } : p);
        return;
      }
      if (signal === 'SIGCONT') {
        processes = processes.map(p => p.pgid === pid ? { ...p, status: 'S' } : p);
        return;
      }
      assert.equal(signal, 'SIGKILL');
      assert(processes.filter(p => p.pid !== 900 && p.pid !== (reusedBackend ? 200 : -1)).every(p => p.status.startsWith('T')), 'must freeze every owned process before the first kill');
      killedGroups.push(pid);
      if (pid === 200 && stuckBackend) return;
      processes = processes.filter(p => p.pgid !== pid);
      if (pid === child.pid) { child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); }
    },
    signals,
    getState: () => ({ launchOptions, closed, child, signals, killedGroups, signaledGroups, processes }),
  };
}

test('boot gate verifies the custom-protocol renderer and an owned backend in isolated HOME', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f);
  const result = await verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env, ...mock });
  assert.equal(result.backendPid, 200);
  assert.equal(result.healthyForMs, 5000);
  assert.equal(mock.getState().launchOptions.env.T3CODE_PORT, '43123');
  assert(mock.getState().launchOptions.args.includes('--use-mock-keychain'));
  assert(mock.getState().launchOptions.args.includes(`--user-data-dir=${path.join(mock.getState().launchOptions.env.HOME, 'Library', 'Application Support', 'tritonai-harness')}`));
  assert.equal(result.credentialStorage, 'not-verified');
  assert.equal(mock.getState().closed, true);
  assert(!fs.existsSync(mock.getState().launchOptions.env.HOME));
});

test('boot gate kills captured detached backend groups before the main group when close stalls', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { hungEvaluation: true, hungClose: true });
  await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env,
    ...mock, operationTimeoutMs: 10, closeTimeoutMs: 10 }), /main-process evaluation timed out/);
  assert.equal(mock.getState().closed, true);
  assert.equal(mock.getState().child.signalCode, 'SIGKILL');
  assert.deepEqual(mock.getState().killedGroups, [200, 100]);
  assert.deepEqual(mock.getState().processes.map(p => p.pid), [900]);
  assert(!fs.existsSync(mock.getState().launchOptions.env.HOME));
});

test('forced cleanup repeatedly freezes detached descendants born between discovery and signaling', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { hungEvaluation: true, hungClose: true, forkDuringCleanup: true });
  await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env,
    ...mock, operationTimeoutMs: 10, closeTimeoutMs: 10 }), /main-process evaluation timed out/);
  assert.deepEqual(mock.getState().killedGroups, [500, 400, 200, 100]);
  assert.deepEqual(mock.getState().processes.map(p => p.pid), [900]);
  assert(!fs.existsSync(mock.getState().launchOptions.env.HOME));
});

test('cleanup refuses to kill when owned processes cannot be frozen and resumes groups it paused', async (t) => {
  const f = fixture(t);
  const child = { pid: 100, exitCode: null, signalCode: null };
  const processes = [{ pid: 100, ppid: 50, pgid: 100, status: 'S', started: 'Wed Sep 9 16:00:00 2026' }];
  const signals = [];
  const tracker = trackBootProcesses(child, () => structuredClone(processes), (pid, signal) => signals.push([pid, signal]), path.join(f.root, 'unfrozen.json'), 10);
  assert.throws(() => tracker.forceStop(), /Could not freeze/);
  assert(signals.some(([, signal]) => signal === 'SIGSTOP'));
  assert.equal(signals.at(-1)[1], 'SIGCONT');
  assert(!signals.some(([, signal]) => signal === 'SIGKILL'));
  assert.equal(tracker.stopped, false);
});

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  const assertCancellation = error => {
    assert.equal(error.code, 'EINTR');
    assert.equal(error.signal, signal);
    assert.equal(error.exitCode, exitCode);
    assert.equal(failureExitCode(error), exitCode);
    return true;
  };
  test(`${signal} during evaluation preserves cancellation through shutdown and removes signal handlers`, async (t) => {
    const f = fixture(t);
    const mock = bootMocks(f, { hungEvaluation: true, hungClose: true });
    const result = verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env,
      ...mock, operationTimeoutMs: 20, closeTimeoutMs: 10 });
    const rejected = assert.rejects(result, assertCancellation);
    await new Promise(resolve => setTimeout(resolve, 5));
    mock.signals.emit(signal);
    assert.equal(mock.getState().child.signalCode, 'SIGKILL');
    assert.deepEqual(mock.getState().killedGroups, [200, 100]);
    await rejected;
    assert.equal(mock.signals.listenerCount('SIGINT'), 0);
    assert.equal(mock.signals.listenerCount('SIGTERM'), 0);
  });

  test(`${signal} during cleanup cancels a pending successful boot result`, async (t) => {
    const f = fixture(t);
    const mock = bootMocks(f, { hungClose: true, closeSignal: signal });
    await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env,
      ...mock, operationTimeoutMs: 20, closeTimeoutMs: 10 }), assertCancellation);
    assert.deepEqual(mock.getState().killedGroups, [200, 100]);
    assert(!fs.existsSync(mock.getState().launchOptions.env.HOME));
    assert.equal(mock.signals.listenerCount('SIGINT'), 0);
    assert.equal(mock.signals.listenerCount('SIGTERM'), 0);
  });
}

test('cancellation exit status survives a failed cleanup and the retained fixture remains available', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { unsafeUserData: true, hungClose: true, closeSignal: 'SIGTERM', stuckBackend: true });
  await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env,
    ...mock, operationTimeoutMs: 10, closeTimeoutMs: 10 }), error => {
      assert.equal(error.signal, 'SIGTERM');
      assert.equal(failureExitCode(error), 143);
      return true;
    });
  assert(fs.existsSync(mock.getState().launchOptions.env.HOME));
  assert.equal(mock.signals.listenerCount('SIGINT'), 0);
  assert.equal(mock.signals.listenerCount('SIGTERM'), 0);
});

test('forced cleanup rejects reused backend PIDs and preserves unrelated process groups', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { hungEvaluation: true, hungClose: true, reusedBackend: true });
  await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env,
    ...mock, operationTimeoutMs: 10, closeTimeoutMs: 10 }), /main-process evaluation timed out/);
  assert.deepEqual(mock.getState().killedGroups, [100]);
  assert.deepEqual(mock.getState().processes.map(p => p.pid), [200, 900]);
});

test('retains the fixture if a detached backend survives forced cleanup after the main exits', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { hungEvaluation: true, hungClose: true, stuckBackend: true });
  await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env,
    ...mock, operationTimeoutMs: 10, closeTimeoutMs: 10 }), /main-process evaluation timed out/);
  assert.equal(mock.getState().child.signalCode, 'SIGKILL');
  assert(fs.existsSync(mock.getState().launchOptions.env.HOME));
  assert.deepEqual(mock.getState().killedGroups, [200, 100]);
});

test('boot gate fails closed if Electron resolves the live user-data directory', async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { unsafeUserData: true });
  await assert.rejects(verifyPackagedBoot({ appPath: f.app, stageRoot: f.stageRoot, version: '0.3.4', env: f.env, ...mock }), /isolated candidate/);
  assert.equal(mock.getState().closed, true);
});

function packagingMocks(f, status = 'Accepted') {
  const calls = [];
  const signedApp = path.join(f.stageApp, 'dist', 'mac-arm64', `${f.productName}.app`);
  const command = (program, args, options = {}) => {
    calls.push({ program, args, options });
    if (program === 'git') return { stdout: 'b'.repeat(40) };
    if (program === 'codesign' && args[0] === '--display') return { stderr: 'Authority=Developer ID Application: Fixture (TEAM)\n' };
    if (program === 'vp') {
      fs.cpSync(f.app, signedApp, { recursive: true });
      fs.writeFileSync(path.join(f.stageApp, 'dist', `TritonAI-Harness-${f.version}-arm64.zip`), 'zip');
      fs.writeFileSync(path.join(f.stageApp, 'dist', `TritonAI-Harness-${f.version}-arm64.zip.blockmap`), 'zip-blockmap');
    }
    if (program.endsWith('ditto')) {
      const target = args[0] === '-x' ? path.join(args.at(-1), `${f.productName}.app`) : args.at(-1);
      fs.cpSync(args[0] === '-x' ? signedApp : args.at(-2), target, { recursive: true });
    }
    if (program === 'hdiutil') {
      if (args[0] === 'create' || args[0] === 'convert') fs.writeFileSync(args.at(-1), 'dmg');
      if (args[0] === 'attach' && args.includes('-readonly')) fs.cpSync(signedApp, path.join(args.at(-1), `${f.productName}.app`), { recursive: true });
    }
    if (program === 'xcrun' && args[0] === 'notarytool') return { stdout: JSON.stringify({ status, id: 'notary-job' }) };
    if (program === 'xcrun' && args[1] === 'staple') fs.appendFileSync(args[2], '-stapled');
    if (program === process.execPath && args.includes('--artifact')) {
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
  assert.equal(signing.options.env.npm_config_user_agent, 'pnpm/11.10.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stageApp, 'package.json'))).build.mac.sign, path.join(f.root, 'scripts/sign-macos.ts'));
  assert.equal(signing.options.env.APPLE_API_KEY, undefined);
  assert.equal(mock.calls.filter(call => call.program === 'vp').length, 1);
  const validation = mock.calls.findIndex(call => call.args[0] === 'scripts/verify-macos-desktop-package.ts');
  const notarization = mock.calls.findIndex(call => call.program === 'xcrun' && call.args[0] === 'notarytool');
  assert(validation > 0 && validation < notarization);
  const finalizer = mock.calls.find((call) => call.args.includes('--artifact'));
  assert.equal(finalizer.args.at(-1), f.release);
});

test('rejected notarization cannot emit successful proof or updater metadata', async (t) => {
  const f = fixture(t);
  const mock = packagingMocks(f, 'Invalid');
  await assert.rejects(finalizeMacRelease({ harnessRoot: f.root, stageRoot: f.stageRoot, version: '0.3.4', outputDir: f.release,
    env: f.env, platform: 'darwin', runCommand: mock.command, packagingTools: mock.tools }), /did not accept/);
  assert(!fs.existsSync(path.join(f.release, 'harness-mac-verification.json')));
  assert(!mock.calls.some((call) => call.args.includes('--artifact')));
});

test('signed payload validation failure stops before ZIP copying, notarization, or success proof', async t => {
  const f = fixture(t), mock = packagingMocks(f);
  await assert.rejects(finalizeMacRelease({ harnessRoot: f.root, stageRoot: f.stageRoot, version: '0.3.4', outputDir: f.release,
    env: f.env, platform: 'darwin', packagingTools: mock.tools, runCommand: (program, args, options) => {
      if (args[0] === 'scripts/verify-macos-desktop-package.ts') throw new Error('fixture: native binary missing');
      return mock.command(program, args, options);
    } }), /native binary missing/);
  assert(!mock.calls.some(call => call.args[0] === 'notarytool'));
  assert(!fs.existsSync(path.join(f.release, 'TritonAI-Harness-0.3.4-arm64.zip')));
  assert(!fs.existsSync(path.join(f.release, 'harness-mac-verification.json')));
});


test('nightly finalization preserves product identity and writes only the nightly updater', async (t) => {
  const version = '0.3.4-nightly.20260912.42';
  const f = fixture(t, version);
  const mock = packagingMocks(f);
  const report = await finalizeMacRelease({ harnessRoot: f.root, stageRoot: f.stageRoot, version, outputDir: f.release,
    env: f.env, platform: 'darwin', runCommand: mock.command, packagingTools: mock.tools,
    verifyBoot: async ({ appPath }) => { assert.equal(path.basename(appPath), 'TritonAI Harness (Nightly).app'); return { healthyForMs: 5000 }; },
  });
  assert.equal(report.version, version);
  assert.match(fs.readFileSync(path.join(f.release, 'nightly-mac.yml'), 'utf8'), /0\.3\.4-nightly\.20260912\.42/);
  assert.equal(fs.existsSync(path.join(f.release, 'latest-mac.yml')), false);
  assert(mock.calls.some(c => c.args.includes('TritonAI Harness (Nightly)')));
  for (const invalid of ['0.3.4-nightly', '0.3.4-nightly.20260912', '0.3.4-rc.1']) assert.throws(() => macReleaseIdentity(invalid), /release version/);
});
