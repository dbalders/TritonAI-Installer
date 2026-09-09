#!/usr/bin/env node
'use strict';

// Run directly from source: Installer's TypeScript build removes dist/ while the
// two release lanes run. Packaging libraries come from the frozen Harness tree.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const net = require('node:net');
const { verifyPluginArchive } = require('./local-release-payload.cjs');

const APP_NAME = 'TritonAI Harness';
const PROOF_NAME = 'tritonai-plugin-composition-mac-arm64.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const { label = path.basename(command), capture = false, ...spawnOptions } = options;
  process.stdout.write(`[harness-mac] ${label}\n`);
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 8 * 1024 * 1024, ...spawnOptions,
  });
  // Do not interpolate arguments or environment: notary arguments contain
  // credential references and must not leak into the release report.
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (${result.error?.code || `exit ${result.status}`}). See the stage log.`);
  }
  return result;
}

function regularFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
  return file;
}

function findKeptStage(stageRoot, version) {
  const root = fs.realpathSync(stageRoot);
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^t3code-desktop-mac-stage-[A-Za-z0-9_-]+$/.test(entry.name))
    .map((entry) => path.join(root, entry.name, 'app'));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one kept macOS stage in the candidate stage root; found ${candidates.length}.`);
  }
  const appRoot = candidates[0];
  if (!fs.lstatSync(appRoot).isDirectory()) throw new Error('Kept macOS stage app must be a real directory.');
  const metadata = JSON.parse(fs.readFileSync(regularFile(path.join(appRoot, 'package.json')), 'utf8'));
  if (metadata.version !== version || metadata.build?.productName !== APP_NAME) {
    throw new Error('Kept macOS stage does not match the requested Harness version/product.');
  }
  return appRoot;
}

function getNotaryConfig(env, configPath = path.join(os.homedir(), '.agents', 'secrets', 'appstore', 'config.json')) {
  let config = {};
  if (!(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) && fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { throw new Error('Local App Store notarization configuration is invalid JSON.'); }
  }
  const key = env.APPLE_API_KEY || (config.keyFile && path.resolve(path.dirname(configPath), config.keyFile));
  const keyId = env.APPLE_API_KEY_ID || config.keyId;
  const issuer = env.APPLE_API_ISSUER || config.issuerId;
  if (![key, keyId, issuer].every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('Set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or configure ~/.agents/secrets/appstore/config.json.');
  }
  regularFile(key);
  return { key: path.resolve(key), keyId, issuer };
}

function resolvePackagingTools(harnessRoot) {
  const desktopRequire = createRequire(path.join(harnessRoot, 'apps', 'desktop', 'package.json'));
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'));
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  return {
    asar: libraryRequire('@electron/asar'),
    // Electron Builder 26.15 owns this implementation; app-builder-bin no longer exists.
    buildBlockMap: libraryRequire('./out/targets/blockmap/blockmap.js').buildBlockMap,
    electron: desktopRequire('playwright-core')._electron,
  };
}

function verifySignedApp(app, identity, runCommand) {
  runCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app], { label: 'Verify candidate app signature' });
  const signature = runCommand('codesign', ['--display', '--verbose=4', app], { capture: true, label: 'Verify pinned Developer ID signer' });
  const details = `${signature.stdout || ''}\n${signature.stderr || ''}`;
  if (!details.split(/\r?\n/).includes(`Authority=Developer ID Application: ${identity}`)) {
    throw new Error('Packaged Harness app was not signed by the pinned Developer ID Application identity.');
  }
}

async function fileInfo(file) {
  regularFile(file);
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { fileName: path.basename(file), size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

function verifyPluginPayload(appPath, composition, asar, version) {
  const archive = regularFile(path.join(appPath, 'Contents', 'Resources', 'app.asar'));
  const read = (entry) => asar.extractFile(archive, entry);
  const metadata = JSON.parse(read('package.json').toString('utf8'));
  if (metadata.version !== version) throw new Error('Packaged Harness app version does not match the candidate.');
  // Harness packages plugin files; the frozen manifest is an external proof.
  // Share exact inventory/hash checks across both platform artifact formats.
  const verified = verifyPluginArchive(archive, asar, composition, 'apps/server/dist/production-integrations/packages');
  const server = read('apps/server/dist/bin.mjs').toString('utf8');
  for (const marker of ['production-integrations', 'tritonai-harness-plugin-composition']) {
    if (!server.includes(marker)) throw new Error(`Packaged backend is missing plugin marker: ${marker}`);
  }
  for (const id of verified.pluginIds) {
    if (!server.includes(id)) throw new Error(`Packaged backend is missing selected plugin: ${id}`);
  }
  return { packages: composition.packages.map(({ id, version: pluginVersion }) => ({ id, version: pluginVersion })), fileCount: verified.files };
}

function diskImageCapacityMib(source) {
  const pending = [source];
  let bytes = 0;
  while (pending.length) {
    const file = pending.pop();
    const stat = fs.lstatSync(file);
    bytes += Math.max(4096, stat.size, Number.isFinite(stat.blocks) ? stat.blocks * 512 : 0);
    if (stat.isDirectory()) for (const child of fs.readdirSync(file)) pending.push(path.join(file, child));
  }
  return Math.max(512, Math.ceil(bytes * 1.3 / 1024 / 1024) + 128);
}

function detachAndClean(mountPoint, scratch, runCommand) {
  // Never recursively delete a mountpoint if detach failed: retain it for recovery.
  runCommand('hdiutil', ['detach', mountPoint, '-force'], { label: 'Detach candidate disk image' });
  fs.rmSync(scratch, { recursive: true, force: true });
}

function createSignedDmg(sourceApp, targetDmg, stageRoot, runCommand) {
  const scratch = fs.mkdtempSync(path.join(stageRoot, 'signed-dmg-'));
  const mountPoint = path.join(scratch, 'mount');
  const writable = path.join(scratch, 'writable.dmg');
  const compressed = path.join(scratch, 'compressed.dmg');
  fs.mkdirSync(mountPoint);
  let mounted = false;
  try {
    runCommand('hdiutil', ['create', '-size', `${diskImageCapacityMib(sourceApp)}m`, '-fs', 'HFS+', '-volname', APP_NAME, '-ov', writable], { label: 'Create writable candidate DMG' });
    runCommand('hdiutil', ['attach', writable, '-nobrowse', '-noverify', '-noautoopen', '-mountpoint', mountPoint], { label: 'Mount writable candidate DMG' });
    mounted = true;
    runCommand('/usr/bin/ditto', ['--noextattr', '--noqtn', sourceApp, path.join(mountPoint, `${APP_NAME}.app`)], { label: 'Copy signed Harness into candidate DMG' });
    fs.symlinkSync('/Applications', path.join(mountPoint, 'Applications'));
    runCommand('hdiutil', ['detach', mountPoint], { label: 'Detach writable candidate DMG' });
    mounted = false;
    runCommand('hdiutil', ['convert', writable, '-format', 'UDZO', '-ov', '-o', compressed], { label: 'Compress signed candidate DMG' });
    fs.renameSync(compressed, targetDmg);
  } finally {
    if (mounted) detachAndClean(mountPoint, scratch, runCommand);
    else fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function withMountedDmg(dmg, stageRoot, runCommand, action) {
  const mountPoint = fs.mkdtempSync(path.join(stageRoot, 'verify-dmg-'));
  let mounted = false;
  try {
    runCommand('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mountPoint], { label: 'Mount final candidate DMG' });
    mounted = true;
    return await action(path.join(mountPoint, `${APP_NAME}.app`));
  } finally {
    if (mounted) detachAndClean(mountPoint, mountPoint, runCommand);
    else fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function isolatedBootEnvironment(home, env) {
  const result = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', '__CF_USER_TEXT_ENCODING']) {
    if (env[key]) result[key] = env[key];
  }
  return {
    ...result, HOME: home, SHELL: '/bin/zsh',
    TRITONAI_HOME: path.join(home, 'harness-state'), T3CODE_HOME: path.join(home, 'harness-state'),
    CODEX_HOME: path.join(home, '.codex'), APPDATA: path.join(home, 'appdata'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  };
}

function ownsProcess(pid, ancestor, runCommand) {
  let current = pid;
  const seen = new Set();
  while (current > 1 && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = Number(runCommand('/bin/ps', ['-p', String(current), '-o', 'ppid='], { capture: true, label: 'Check candidate backend ownership' }).stdout.trim());
  }
  return false;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function processSnapshot(runCommand) {
  const output = runCommand('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    capture: true, timeout: 2000, label: 'Read candidate process ownership',
  }).stdout;
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!fields) throw new Error('Could not parse candidate process ownership snapshot.');
    return { pid: Number(fields[1]), ppid: Number(fields[2]), pgid: Number(fields[3]), status: fields[4], started: fields[5].trim().replace(/\s+/g, ' ') };
  });
}

function trackBootProcesses(child, readSnapshot, signalGroup, receipt, freezeTimeoutMs = 2000) {
  const owned = new Map();
  const groups = new Map();
  const matches = (a, b) => a.pid === b.pid && a.pgid === b.pgid && a.started === b.started;
  const tracker = {
    stopped: false,
    capture() {
      const current = readSnapshot();
      const live = current.filter((entry) => !entry.status.startsWith('Z'));
      const descendants = new Map();
      if (!owned.size) {
        const root = live.find((entry) => entry.pid === child.pid);
        if (!root || root.pgid !== child.pid || child.exitCode !== null || child.signalCode !== null) {
          throw new Error('Could not establish the launched candidate process group.');
        }
        descendants.set(root.pid, 0);
      }
      for (const entry of live) {
        const previous = owned.get(entry.pid);
        if (previous && matches(previous, entry)) descendants.set(entry.pid, previous.depth);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of live) if (!descendants.has(entry.pid) && descendants.has(entry.ppid)) {
          descendants.set(entry.pid, descendants.get(entry.ppid) + 1);
          changed = true;
        }
      }
      for (const entry of live) if (descendants.has(entry.pid)) {
        const record = { ...entry, depth: descendants.get(entry.pid) };
        owned.set(entry.pid, record);
        if (entry.pid === entry.pgid) groups.set(entry.pgid, record.depth);
      }
      fs.writeFileSync(receipt, `${JSON.stringify([...owned.values()], null, 2)}\n`, { mode: 0o600 });
      return live.filter((entry) => owned.has(entry.pid) && matches(owned.get(entry.pid), entry));
    },
    forceStop() {
      const deadline = Date.now() + freezeTimeoutMs;
      const paused = new Set();
      const activeGroups = (remaining) => [...groups].filter(([pgid]) => remaining.some((entry) => entry.pgid === pgid));
      try {
        let remaining = tracker.capture();
        // Keep ancestry intact while stopping forks. A child can enter a new
        // detached group between a snapshot and SIGSTOP, so discover again
        // until every owned live process is observed stopped before any kill.
        while (remaining.some((entry) => !entry.status.startsWith('T'))) {
          if (Date.now() >= deadline) throw new Error('Could not freeze the owned candidate process tree; retained the boot fixture.');
          for (const [pgid] of activeGroups(remaining).sort((a, b) => a[1] - b[1])) {
            if (!remaining.some((entry) => entry.pgid === pgid && !entry.status.startsWith('T'))) continue;
            try { signalGroup(pgid, 'SIGSTOP'); paused.add(pgid); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
          remaining = tracker.capture();
        }
        let failure;
        for (const [pgid] of activeGroups(remaining).sort((a, b) => b[1] - a[1])) {
          try { signalGroup(pgid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') failure ||= error; }
        }
        if (failure) throw failure;
      } catch (error) {
        // Restore only groups we paused and can still identify. A failed proof
        // leaves the fixture for recovery rather than silently deleting it.
        for (const [pgid] of activeGroups(tracker.capture())) if (paused.has(pgid)) {
          try { signalGroup(pgid, 'SIGCONT'); } catch { /* preserve original failure */ }
        }
        throw error;
      }
    },
    async waitForExit(milliseconds) {
      const deadline = Date.now() + milliseconds;
      while (tracker.capture().length) {
        if (Date.now() >= deadline) throw new Error('Owned candidate processes remain after shutdown; retained the boot fixture.');
        await sleep(25);
      }
      tracker.stopped = true;
    },
  };
  return tracker;
}

async function closeBootApplication(application, tracker, milliseconds) {
  let ownershipError;
  try { tracker.capture(); } catch (error) { ownershipError = error; }
  try {
    await bounded(application.close(), milliseconds, 'Packaged Harness shutdown');
  } finally {
    tracker.forceStop();
    await tracker.waitForExit(milliseconds);
  }
  if (ownershipError) throw ownershipError;
}

async function verifyPackagedBoot({ appPath, stageRoot, version, electron, env, runCommand = run, wait = sleep,
  selectPort = availablePort, fetchResponse = fetch, assertAlive = (pid) => process.kill(pid, 0),
  operationTimeoutMs = 10_000, closeTimeoutMs = 5000, killGroup = (pid, signal) => process.kill(-pid, signal),
  readProcessSnapshot = () => processSnapshot(runCommand), signals = process }) {
  const scratch = fs.mkdtempSync(path.join(stageRoot, 'packaged-boot-'));
  const home = path.join(scratch, 'home');
  const installedApp = path.join(scratch, `${APP_NAME}.app`);
  const bootLog = `${scratch}.log`;
  fs.mkdirSync(home);
  let application;
  let child;
  let processes;
  let bootError;
  let interrupted = false;
  let loggedBytes = 0;
  const captureOutput = (chunk) => {
    const bytes = Buffer.from(chunk).subarray(0, Math.max(0, 2 * 1024 * 1024 - loggedBytes));
    if (bytes.length) fs.appendFileSync(bootLog, bytes);
    loggedBytes += bytes.length;
  };
  const onInterruption = () => {
    interrupted = true;
    // Do not wait for an Electron main thread that may be blocked in native UI.
    if (processes) {
      try { processes.forceStop(); }
      catch (error) { process.stderr.write(`[harness-mac] Candidate interruption cleanup failed: ${error.message}\n`); }
    }
  };
  try {
    const backendPort = await selectPort();
    runCommand('/usr/bin/ditto', ['--noextattr', '--noqtn', appPath, installedApp], { label: 'Install exact candidate in isolated boot directory' });
    application = await electron.launch({
      executablePath: path.join(installedApp, 'Contents', 'MacOS', APP_NAME),
      env: { ...isolatedBootEnvironment(home, env), T3CODE_PORT: String(backendPort) }, cwd: home, timeout: 60_000,
      // executablePath skips Playwright's Electron loader, including its normal
      // mock-keychain switch. This credential-free fixture must not initialize
      // or prompt for a login keychain in the disposable HOME.
      args: ['--remote-debugging-address=127.0.0.1', '--use-mock-keychain',
        `--user-data-dir=${path.join(home, 'Library', 'Application Support', 'tritonai-harness')}`],
    });
    child = application.process();
    processes = trackBootProcesses(child, readProcessSnapshot, killGroup, `${scratch}.processes.json`);
    processes.capture();
    fs.writeFileSync(bootLog, '', { flag: 'wx', mode: 0o600 });
    child.stdout?.on('data', captureOutput);
    child.stderr?.on('data', captureOutput);
    for (const signal of ['SIGINT', 'SIGTERM']) signals.on(signal, onInterruption);
    process.stdout.write(`[harness-mac] Isolated packaged boot process ${child.pid}; log ${bootLog}\n`);
    const deadline = Date.now() + 60_000;
    let result;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('Packaged Harness boot interrupted.');
      processes.capture();
      const state = await bounded(application.evaluate(({ app, BrowserWindow }) => ({
        version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData'),
        windows: BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => ({
          visible: window.isVisible(), url: window.webContents.getURL(), rendererPid: window.webContents.getOSProcessId(),
        })),
      })), operationTimeoutMs, 'Packaged Harness main-process evaluation');
      if (state.version !== version || !state.packaged ||
          !state.userData.startsWith(`${home}${path.sep}`)) throw new Error('Packaged Harness boot did not use the isolated candidate version/user-data directory.');
      const window = state.windows.find((entry) => entry.visible && entry.url.startsWith('t3code://app/') && entry.rendererPid > 0);
      if (window) {
        const page = application.windows().find((entry) => entry.url() === window.url);
        if (page && await bounded(page.evaluate(() => document.readyState === 'complete' && Boolean(document.body?.innerText.trim())), operationTimeoutMs, 'Packaged Harness renderer evaluation')) {
          // Current Harness serves the client through t3code://app and exposes
          // this unauthenticated readiness descriptor on its separate backend.
          const response = await fetchResponse(`http://127.0.0.1:${backendPort}/.well-known/t3/environment`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
          if (!response.ok) throw new Error('Packaged Harness backend did not return a healthy renderer response.');
          await response.body?.cancel();
          const listeners = runCommand('/usr/sbin/lsof', ['-nP', `-iTCP:${backendPort}`, '-sTCP:LISTEN', '-Fp'], { capture: true, label: 'Verify live candidate backend process' }).stdout;
          const backendPids = [...new Set([...listeners.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1])))];
          const backendPid = backendPids.find((pid) => pid !== child.pid && ownsProcess(pid, child.pid, runCommand));
          if (!backendPid) throw new Error('Candidate backend listener is not a child of the packaged Harness process.');
          assertAlive(window.rendererPid);
          result = { version, packaged: true, visibleWindow: true, rendererReady: true, rendererPid: window.rendererPid, backendPid, backendPort, isolatedUserData: true };
          break;
        }
      }
      await wait(500);
    }
    if (!result) throw new Error('Packaged Harness did not open a visible, live renderer with its own backend within 60 seconds.');
    await wait(5000);
    assertAlive(result.rendererPid);
    assertAlive(result.backendPid);
    const stillVisible = await bounded(application.evaluate(({ BrowserWindow }, rendererPid) => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible() && window.webContents.getOSProcessId() === rendererPid), result.rendererPid), operationTimeoutMs, 'Packaged Harness window stability evaluation');
    if (!stillVisible) throw new Error('Packaged Harness window disappeared during the boot stability check.');
    if (interrupted) throw new Error('Packaged Harness boot interrupted.');
    return { ...result, keychain: 'mock-for-isolated-boot', credentialStorage: 'not-verified', healthyForMs: 5000, verifiedAt: new Date().toISOString() };
  } catch (error) {
    bootError = error;
    throw error;
  } finally {
    try {
      if (application && processes) await closeBootApplication(application, processes, closeTimeoutMs);
    } catch (error) {
      // Keep the primary failure actionable; an unresponsive close should not
      // replace a main-thread timeout with a less useful shutdown message.
      if (!bootError) throw error;
      process.stderr.write(`[harness-mac] ${error.message}\n`);
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM']) signals.off(signal, onInterruption);
      child?.stdout?.off('data', captureOutput);
      child?.stderr?.off('data', captureOutput);
      // Preserve the owned installation if termination itself failed.
      if (!child || processes?.stopped) fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

async function finalizeMacRelease({ harnessRoot, stageRoot, version, env = process.env, runCommand = run,
  packagingTools, verifyBoot = verifyPackagedBoot, platform = process.platform, configPath, outputDir }) {
  if (platform !== 'darwin') throw new Error('Harness macOS finalization must run on macOS.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('A stable release version is required.');
  harnessRoot = fs.realpathSync(harnessRoot);
  stageRoot = fs.realpathSync(stageRoot);
  const stageApp = findKeptStage(stageRoot, version);
  const identity = env.DEVELOPER_ID_APPLICATION?.replace(/^Developer ID Application:\s*/, '').trim();
  if (!identity) throw new Error('DEVELOPER_ID_APPLICATION must pin the signing identity.');
  const notary = getNotaryConfig(env, configPath);
  const output = path.resolve(outputDir || env.T3CODE_DESKTOP_OUTPUT_DIR || path.join(harnessRoot, 'release'));
  const inputPath = regularFile(path.join(output, `.${PROOF_NAME}.input`));
  const composition = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(path.dirname(stageApp), 'plugin-composition-input', 'manifest.json'), 'utf8'));
  if (!isDeepStrictEqual(composition, snapshot)) throw new Error('Kept macOS stage plugin snapshot differs from the frozen build proof.');
  const tools = packagingTools || resolvePackagingTools(harnessRoot);
  const exec = (command, args, options) => runCommand(command, args, { cwd: harnessRoot, env, ...options });
  const commit = exec('git', ['rev-parse', 'HEAD'], { capture: true, label: 'Verify kept stage source commit' }).stdout.trim();
  const stageMetadata = JSON.parse(fs.readFileSync(path.join(stageApp, 'package.json'), 'utf8'));
  // Harness embeds its 12-character source identifier in the stage package.
  if (!/^[a-f0-9]{40}$/.test(commit) || stageMetadata.t3codeCommitHash !== commit.slice(0, 12)) {
    throw new Error('Kept macOS stage source commit differs from the frozen Harness worktree.');
  }
  const dist = path.join(stageApp, 'dist');
  // These are generated outputs of the unique candidate stage, never source or another candidate.
  fs.rmSync(dist, { recursive: true, force: true });
  const signingEnv = { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'true', CSC_NAME: identity };
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete signingEnv[key];
  exec('vp', ['exec', '--filter', '@t3tools/desktop', '--', 'electron-builder', '--projectDir', stageApp, '--mac', '--arm64', '--publish', 'never'], { env: signingEnv, label: 'Sign staged Harness and build updater ZIP' });
  const signedApp = path.join(dist, 'mac-arm64', `${APP_NAME}.app`);
  verifySignedApp(signedApp, identity, exec);
  const stagedProof = verifyPluginPayload(signedApp, composition, tools.asar, version);
  const zipName = `TritonAI-Harness-${version}-arm64.zip`;
  const zip = path.join(output, zipName);
  const dmg = path.join(output, `TritonAI-Harness-${version}-arm64.dmg`);
  fs.copyFileSync(regularFile(path.join(dist, zipName)), zip);
  fs.copyFileSync(regularFile(path.join(dist, `${zipName}.blockmap`)), `${zip}.blockmap`);
  createSignedDmg(signedApp, dmg, stageRoot, exec);
  await withMountedDmg(dmg, stageRoot, exec, (app) => {
    verifySignedApp(app, identity, exec);
    verifyPluginPayload(app, composition, tools.asar, version);
  });
  exec('codesign', ['--force', '--sign', `Developer ID Application: ${identity}`, '--timestamp', dmg], { label: 'Sign candidate DMG' });
  const notarization = exec('xcrun', ['notarytool', 'submit', dmg, '--key', notary.key, '--key-id', notary.keyId, '--issuer', notary.issuer, '--wait', '--output-format', 'json'], { capture: true, label: 'Notarize candidate DMG and wait for Apple' });
  let receipt;
  try { receipt = JSON.parse(notarization.stdout); } catch { throw new Error('Apple notarization did not return a valid JSON receipt.'); }
  if (receipt.status !== 'Accepted') throw new Error('Apple notarization did not accept the candidate DMG.');
  exec('xcrun', ['stapler', 'staple', dmg], { label: 'Staple accepted candidate DMG' });
  exec('xcrun', ['stapler', 'validate', dmg], { label: 'Validate stapled notarization' });
  exec('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg], { label: 'Assess candidate DMG with Gatekeeper' });
  exec('hdiutil', ['verify', dmg], { label: 'Verify final DMG integrity' });
  const boot = await withMountedDmg(dmg, stageRoot, exec, async (app) => {
    verifySignedApp(app, identity, exec);
    verifyPluginPayload(app, composition, tools.asar, version);
    return verifyBoot({ appPath: app, stageRoot, version, electron: tools.electron, env, runCommand: exec });
  });
  const zipScratch = fs.mkdtempSync(path.join(stageRoot, 'verify-zip-'));
  try {
    exec('/usr/bin/ditto', ['-x', '-k', zip, zipScratch], { label: 'Extract final updater ZIP for verification' });
    const zipApp = path.join(zipScratch, `${APP_NAME}.app`);
    verifySignedApp(zipApp, identity, exec);
    verifyPluginPayload(zipApp, composition, tools.asar, version);
    const [zipAsar, signedAsar] = await Promise.all([zipApp, signedApp].map((app) => fileInfo(path.join(app, 'Contents', 'Resources', 'app.asar'))));
    if (zipAsar.sha256 !== signedAsar.sha256) throw new Error('Updater ZIP differs from the signed candidate app.');
  } finally { fs.rmSync(zipScratch, { recursive: true, force: true }); }
  await tools.buildBlockMap(dmg, 'gzip', `${dmg}.blockmap`);
  const [zipInfo, dmgInfo] = await Promise.all([fileInfo(zip), fileInfo(dmg)]);
  const latest = `version: ${version}\nfiles:\n  - url: ${zipInfo.fileName}\n    sha512: ${zipInfo.sha512}\n    size: ${zipInfo.size}\n  - url: ${dmgInfo.fileName}\n    sha512: ${dmgInfo.sha512}\n    size: ${dmgInfo.size}\npath: ${zipInfo.fileName}\nsha512: ${zipInfo.sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
  fs.writeFileSync(path.join(output, 'latest-mac.yml'), latest);
  exec(process.execPath, ['scripts/finalize-managed-plugin-proof.ts', '--platform', 'mac', '--arch', 'arm64', '--artifact', dmg, '--output-dir', output], { label: 'Bind plugin proof to final DMG bytes' });
  const proof = JSON.parse(fs.readFileSync(path.join(output, PROOF_NAME), 'utf8'));
  const { artifacts, ...boundComposition } = proof;
  if (!isDeepStrictEqual(boundComposition, composition) || !isDeepStrictEqual(artifacts, [{ fileName: dmgInfo.fileName, size: dmgInfo.size, sha512: dmgInfo.sha512 }])) {
    throw new Error('Final plugin proof is not bound to the exact verified candidate DMG.');
  }
  regularFile(`${dmg}.blockmap`);
  const report = { schemaVersion: 1, version, sourceCommit: commit, platform: 'macos-arm64', verifiedAt: new Date().toISOString(),
    notarization: { status: receipt.status, id: receipt.id }, pluginSource: composition.source, plugins: stagedProof,
    artifacts: [dmgInfo, zipInfo], boot };
  fs.writeFileSync(path.join(output, 'harness-mac-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

module.exports = { findKeptStage, getNotaryConfig, resolvePackagingTools, fileInfo, verifyPluginPayload, processSnapshot, trackBootProcesses,
  createSignedDmg, withMountedDmg, isolatedBootEnvironment, ownsProcess, verifyPackagedBoot, finalizeMacRelease };

if (require.main === module) {
  const [harnessRoot, stageRoot, version, outputDir, ...extra] = process.argv.slice(2);
  if (!harnessRoot || !stageRoot || !version || extra.length) {
    process.stderr.write('Usage: node scripts/local-release-mac.cjs <harness-worktree> <stage-root> <version> [output-dir]\n');
    process.exitCode = 1;
  } else {
    finalizeMacRelease({ harnessRoot, stageRoot, version, outputDir }).then(() => {
      process.stdout.write('[harness-mac] Signed, notarized, payload-verified and boot-verified macOS Harness is ready.\n');
    }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}
