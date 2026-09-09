'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareWindowsToolchain, verifyCompiler, translatePaths, launcherSource, NSIS_SHA256 } = require('./local-release-windows.cjs');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tritonai-windows-helper-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
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
