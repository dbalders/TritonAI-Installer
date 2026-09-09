'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { prepareWindowsToolchain, verifyCompiler, translatePaths, launcherSource, NSIS_SHA256, runTool, initializeWinePrefix } = require('./local-release-windows.cjs');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tritonai-windows-helper-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('timeout stops owned descendants whose inherited pipes outlive the initial process', async (t) => {
  if (process.platform === 'win32') return t.skip('macOS process-group ownership');
  const logs = [];
  let descendant;
  t.after(() => { if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } });
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});console.log('descendant='+child.pid);child.unref();process.exit(0);`;
  const started = Date.now();
  await assert.rejects(runTool(process.execPath, ['-e', source], { timeout: 500, progressInterval: 50, label: 'Wine init fixture', log: line => logs.push(line) }), error => {
    assert.equal(error.code, 'ETIMEDOUT');
    descendant = Number(error.output.match(/descendant=(\d+)/)?.[1]);
    assert.ok(descendant > 0, error.message);
    assert.match(error.message, /Wine init fixture timed out/);
    return true;
  });
  assert.ok(Date.now() - started < 4000, 'inherited pipes must not keep the timeout pending');
  assert.ok(logs.some(line => /running for/.test(line)), 'long steps emit progress without requiring subprocess output');
  await new Promise(resolve => setTimeout(resolve, 100));
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(descendant)], { encoding: 'utf8' });
  assert.ok(!status.stdout.trim() || status.stdout.trim().startsWith('Z'), `owned descendant still running: ${status.stdout}`);
});

test('timeout settles even if a detached descendant still owns a pipe', async (t) => {
  if (process.platform === 'win32') return t.skip('macOS detached Wine service behavior');
  let descendant;
  t.after(() => { if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } });
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});console.log('descendant='+child.pid);child.unref();process.exit(0);`;
  const started = Date.now();
  await assert.rejects(runTool(process.execPath, ['-e', source], { timeout: 500 }), error => {
    descendant = Number(error.output.match(/descendant=(\d+)/)?.[1]);
    assert.ok(descendant > 0);
    return error.code === 'ETIMEDOUT';
  });
  assert.ok(Date.now() - started < 4000, 'settling cannot depend on detached service pipes closing');
});

test('initializes default Wine drives before custom mappings and rejects partial prefixes', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS Wine prefix layout');
  const root = fixture(t), prefix = path.join(root, 'prefix'), compiler = path.join(root, 'compiler.cjs');
  fs.mkdirSync(prefix);
  fs.writeFileSync(compiler, `const fs=require('node:fs'),path=require('node:path'),p=process.env.WINEPREFIX; if(fs.existsSync(path.join(p,'dosdevices')))process.exit(17);fs.mkdirSync(path.join(p,'drive_c'));fs.mkdirSync(path.join(p,'dosdevices'));fs.symlinkSync('../drive_c',path.join(p,'dosdevices','c:'));fs.symlinkSync('/',path.join(p,'dosdevices','z:'));console.log('v3.04');`);
  await initializeWinePrefix({ wine: process.execPath, compiler, prefix, env: { ...process.env, WINEPREFIX: prefix } });
  assert.equal(fs.realpathSync(path.join(prefix, 'dosdevices', 'c:')), path.join(prefix, 'drive_c'));
  const partial = path.join(root, 'partial');
  fs.mkdirSync(path.join(partial, 'dosdevices'), { recursive: true });
  fs.symlinkSync(root, path.join(partial, 'dosdevices', 't:'));
  await assert.rejects(initializeWinePrefix({ wine: process.execPath, compiler, prefix: partial, env: { ...process.env, WINEPREFIX: partial } }), /Incomplete Wine prefix.*default C: and Z: drives/);
});

function wineServiceFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tritonai-wine-service-')));
  const prefix = path.join(root, 'prefix'), compiler = path.join(root, 'compiler.cjs');
  const pidFile = path.join(prefix, 'service.pid'), cleaned = path.join(root, 'cleanup.json');
  fs.mkdirSync(prefix);
  t.after(() => {
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(compiler, `const {spawn}=require('node:child_process'),fs=require('node:fs');const service=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(pidFile)},String(service.pid));service.unref();process.exit(0);`);
  const wine = path.join(root, 'wine'), server = path.join(root, 'wineserver');
  fs.writeFileSync(wine, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(server, `#!${process.execPath}\nconst fs=require('node:fs');const prefix=process.env.WINEPREFIX;if(prefix!==${JSON.stringify(prefix)})process.exit(19);const args=process.argv.slice(2);if(args.length!==1||args[0]!=='-k')process.exit(20);process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)})),'SIGKILL');fs.writeFileSync(${JSON.stringify(cleaned)},JSON.stringify({prefix,args}));`, { mode: 0o755 });
  return { prefix, wine, compiler, pidFile, cleaned };
}

test('timed-out Wine initialization stops only services recorded in the exact prefix', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS Wine service cleanup');
  const { prefix, wine, compiler, cleaned } = wineServiceFixture(t);
  const started = Date.now();
  await assert.rejects(initializeWinePrefix({ wine, compiler, prefix, env: { ...process.env, WINEPREFIX: prefix }, timeout: 500 }), error => error.code === 'ETIMEDOUT');
  assert.ok(Date.now() - started < 4000);
  assert.deepEqual(JSON.parse(fs.readFileSync(cleaned)), { prefix, args: ['-k'] });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} interrupts the owned group, cleans the exact Wine prefix, and removes listeners`, async (t) => {
    if (process.platform !== 'darwin') return t.skip('macOS Wine service cleanup');
    const { prefix, wine, compiler, pidFile, cleaned } = wineServiceFixture(t);
    const driverSource = `const {initializeWinePrefix}=require(${JSON.stringify(require.resolve('./local-release-windows.cjs'))});initializeWinePrefix(${JSON.stringify({ wine, compiler, prefix })}).catch(error=>{console.log(JSON.stringify({code:error.code,signal:error.signal,exitCode:error.exitCode,sigintListeners:process.listenerCount('SIGINT'),sigtermListeners:process.listenerCount('SIGTERM')}));process.exitCode=error.exitCode||1;});`;
    const driver = spawn(process.execPath, ['-e', driverSource], { env: { ...process.env, WINEPREFIX: prefix }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { try { driver.kill('SIGKILL'); } catch {} });
    let output = '', stderr = '';
    driver.stdout.on('data', data => { output += data; });
    driver.stderr.on('data', data => { stderr += data; });
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { driver.kill('SIGKILL'); reject(new Error('Interrupted Wine driver did not settle')); }, 5000);
      driver.on('close', code => { clearTimeout(timer); resolve(code); });
      driver.on('error', error => { clearTimeout(timer); reject(error); });
    });
    for (let attempts = 0; !fs.existsSync(pidFile); attempts++) {
      assert.ok(attempts < 200, 'Wine service fixture did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    driver.kill(signal);
    const code = await completion;
    const expectedExit = signal === 'SIGINT' ? 130 : 143;
    assert.equal(code, expectedExit, stderr);
    assert.deepEqual(JSON.parse(output.trim()), { code: 'EINTR', signal, exitCode: expectedExit, sigintListeners: 0, sigtermListeners: 0 });
    assert.deepEqual(JSON.parse(fs.readFileSync(cleaned)), { prefix, args: ['-k'] });
  });
}

test('maps long template and toolchain paths without changing Windows flags, URLs or dollar expressions', () => {
  const mappings = [['/Users/test/candidate/toolchains/win', 'T:'], ['/Users/test/node_modules/templates/nsis', 'T:/templates'], ['/Users/test/candidate', 'U:']];
  const script = '!include "/Users/test/node_modules/templates/nsis/include/common.nsh"\nFile "/Users/test/candidate/toolchains/win/data file.bin"\n!include "/private/tmp/script.nsh"\nDetailPrint "https://example.test/path ${NSISDIR}"';
  assert.equal(translatePaths(script, mappings), '!include "T:\\templates\\include\\common.nsh"\nFile "T:\\data file.bin"\n!include "Z:\\private\\tmp\\script.nsh"\nDetailPrint "https://example.test/path ${NSISDIR}"');
  assert.equal(translatePaths('-DPROJECT_DIR=/Users/test/project with spaces', mappings), '-DPROJECT_DIR=Z:\\Users\\test\\project with spaces');
  assert.equal(translatePaths('-XVIAddVersionKey /LANG=1033 CompanyName "UC San Diego"', mappings), '-XVIAddVersionKey /LANG=1033 CompanyName "UC San Diego"');
  assert.equal(translatePaths('ExecWait \'"$INSTDIR/app.exe" /S /D=$INSTDIR\'', mappings), 'ExecWait \'"$INSTDIR/app.exe" /S /D=$INSTDIR\'');
  assert.equal(translatePaths('-DUNINSTALLER_OUT_FILE=Z:\\Users\\test\\candidate\\harness-win\\output.exe', mappings), '-DUNINSTALLER_OUT_FILE=U:\\harness-win\\output.exe');
  assert.equal(translatePaths('-DAPP_64=Z:/Users/test/candidate/harness-win/output.nsis.7z', mappings), '-DAPP_64=U:\\harness-win\\output.nsis.7z');
  assert.equal(translatePaths('-DAPP_64=/Users/test/candidate/harness-win/output.nsis.7z', mappings), '-DAPP_64=U:\\harness-win\\output.nsis.7z');
});

test('always rejects an unpinned compiler, including an existing stale cache', (t) => {
  const dir = fixture(t), compiler = path.join(dir, 'makensis.exe');
  fs.writeFileSync(compiler, 'stale compiler');
  assert.throws(() => verifyCompiler(compiler), /NSIS 3\.0\.4\.1 compiler hash mismatch/);
  fs.writeFileSync(compiler, 'another compiler');
  assert.throws(() => verifyCompiler(compiler), new RegExp(NSIS_SHA256));
});

test('launcher forwards stdin and exact argument boundaries, pins prefix, and catches changes before Wine runs', (t) => {
  const dir = fixture(t), compiler = path.join(dir, 'compiler.cjs'), templates = path.join(dir, 'templates');
  fs.mkdirSync(templates);
  // Native Node runs the fake compiler on both CI hosts; Windows cannot execute a shebang shim.
  const wine = process.execPath, record = path.join(dir, 'record.json');
  const compilerSource = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(1),input:fs.readFileSync(0,'utf8'),prefix:process.env.WINEPREFIX,nsis:process.env.NSISDIR,cwd:process.cwd()}));\n`;
  fs.writeFileSync(compiler, compilerSource);
  const launcher = path.join(dir, 'launcher.cjs');
  fs.writeFileSync(launcher, launcherSource({ compiler, compilerSha256: crypto.createHash('sha256').update(compilerSource).digest('hex'), wine, nsisRoot: dir + '/nsis', templates, templateSource: '/very long/source/templates', root: dir, prefix: dir + '/wineprefix' }));
  const result = spawnSync(process.execPath, [launcher, '-DOUTPUT=' + dir + '/file with spaces.exe', '-XName Example app', '-'], { input: '!include "/very long/source/templates/common.nsh"\nOutFile "' + dir + '/output.exe"', encoding: 'utf8', env: { ...process.env, WINEPREFIX: '/unrelated/prefix' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(record)), { args: [compiler, '-DOUTPUT=T:\\file with spaces.exe', '-XName Example app', '-'], input: '!include "T:\\templates\\common.nsh"\nOutFile "T:\\output.exe"', prefix: dir + '/wineprefix', nsis: 'T:\\nsis\\', cwd: fs.realpathSync(templates) });
  const harnessTemplates = path.join(dir, 'harness templates');
  fs.mkdirSync(harnessTemplates);
  fs.writeFileSync(path.join(templates, 'installer.nsi'), 'pinned templates');
  fs.writeFileSync(path.join(harnessTemplates, 'installer.nsi'), 'pinned templates');
  const otherCheckout = spawnSync(process.execPath, [launcher, '-'], { cwd: harnessTemplates, input: `!include "${harnessTemplates}/installer.nsi"`, encoding: 'utf8' });
  assert.equal(otherCheckout.status, 0, otherCheckout.stderr);
  assert.equal(JSON.parse(fs.readFileSync(record)).input, '!include "T:\\templates\\installer.nsi"');
  fs.writeFileSync(path.join(harnessTemplates, 'installer.nsi'), 'different builder version');
  const mismatch = spawnSync(process.execPath, [launcher, '-'], { cwd: harnessTemplates, input: '', encoding: 'utf8' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /NSIS templates differ/);
  fs.rmSync(record);
  fs.writeFileSync(compiler, 'modified since preparation');
  const stale = spawnSync(process.execPath, [launcher, '-VERSION'], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Pinned NSIS compiler changed/);
  assert.equal(fs.existsSync(record), false);
});

test('requires an isolated absolute root and refuses a root symlink without touching its target', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS toolchain entry point');
  const dir = fixture(t), target = path.join(dir, 'shared'), linked = path.join(dir, 'linked');
  fs.mkdirSync(target);
  fs.symlinkSync(target, linked);
  await assert.rejects(prepareWindowsToolchain({ root: 'relative', installerRoot: dir }), /absolute paths/);
  await assert.rejects(prepareWindowsToolchain({ root: linked, installerRoot: dir }), /must not be a symlink/);
  assert.deepEqual(fs.readdirSync(target), []);
  await assert.rejects(prepareWindowsToolchain({ root: path.join(dir, 'own-cache'), candidateRoot: target, installerRoot: dir }), /must be inside candidateRoot/);
  const root = path.join(dir, 'candidate');
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  fs.symlinkSync(target, path.join(root, 'cache', 'nsis-3.0.4.1'));
  await assert.rejects(prepareWindowsToolchain({ root, installerRoot: dir }), /symlink escapes its candidate/);
  assert.deepEqual(fs.readdirSync(target), []);
});
