const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { verifyWindowsInstaller, validateArchiveListing } = require('./local-release-installer.cjs');
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const asar = builderRequire('@electron/asar'), { FileMatcher } = builderRequire('./out/fileMatcher.js');

function pe(x64 = false) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(x64 ? 0x8664 : 0x14c, 68); bytes.writeUInt16LE(x64 ? 0x20b : 0x10b, 88);
  return bytes;
}

async function fixture(t, modify = () => {}, version = '0.3.4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installerRoot = path.join(root, 'installer'), outputDirectory = path.join(installerRoot, 'artifacts/windows-installer');
  const app = path.join(root, 'app'), resources = path.join(app, 'resources'), archiveSource = path.join(root, 'asar');
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const mappings = [
    { from: 'vendor/t3code-desktop/win-x64', to: 'vendor/t3code-desktop/win-x64', filter: ['latest.yml', 'windows-artifact-trust.json', 'tritonai-plugin-composition.json', 'TritonAI-Harness-*.exe'] },
    { from: 'vendor/skills', to: 'vendor/skills', filter: ['**/*'] },
    { from: 'vendor/codex-cli/win-x64', to: 'vendor/codex-cli/win-x64', filter: ['**/*'] },
    { from: 'vendor/node-runtime/win-x64', to: 'vendor/node-runtime/win-x64', filter: ['manifest.json', 'node-v*.zip'] },
    { from: 'build/managed-config.generated.json', to: 'managed-config.json' },
    { from: 'build/managed-plugin-composition.generated.json', to: 'managed-plugin-composition.json' },
  ];
  write(path.join(installerRoot, 'electron-builder.win.json'), JSON.stringify({ extraResources: mappings }));
  for (const name of ['latest.yml', 'windows-artifact-trust.json', 'tritonai-plugin-composition.json']) write(path.join(installerRoot, mappings[0].from, name), name);
  const harnessArtifact = path.join(root, 'verified-harness.exe'); write(harnessArtifact, pe());
  write(path.join(installerRoot, mappings[0].from, 'TritonAI-Harness-0.3.4-x64.exe'), pe());
  for (const name of ['manifest.json', 'skill/SKILL.md', 'skill/.hidden']) write(path.join(installerRoot, 'vendor/skills', name), name);
  write(path.join(installerRoot, 'vendor/codex-cli/win-x64/lib/node_modules/codex/codex.exe'), pe(true));
  for (const name of ['manifest.json', 'node-v22.zip', 'ignored.txt']) write(path.join(installerRoot, 'vendor/node-runtime/win-x64', name), name);
  write(path.join(installerRoot, 'build/managed-config.generated.json'), '{"private":"must not appear in errors"}');
  write(path.join(installerRoot, 'build/managed-plugin-composition.generated.json'), '{"managed":true}');
  for (const mapping of mappings) {
    const from = path.join(installerRoot, mapping.from), to = path.join(resources, mapping.to);
    const matcher = new FileMatcher(from, to, value => value, mapping.filter);
    if (matcher.isEmpty()) matcher.prependPattern('**/*');
    const filter = matcher.createFilter();
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: source => filter(source, fs.lstatSync(source)) });
  }
  write(path.join(archiveSource, 'package.json'), JSON.stringify({ version }));
  await asar.createPackage(archiveSource, path.join(resources, 'app.asar'));
  write(path.join(app, 'TritonAI Installer.exe'), pe(true));
  const names = ['TritonAI-Installer-Setup-0.3.4-x64.exe', 'TritonAI-Installer-0.3.4-x64-portable.exe'];
  for (const name of names) write(path.join(outputDirectory, name), pe());
  const calls = []; let kind;
  const tools = { asar, FileMatcher, extract: async (archive, destination) => {
    calls.push(archive);
    if (archive.endsWith('.exe')) {
      kind = archive.includes('-Setup-') ? 'setup' : 'portable';
      write(path.join(destination, '$PLUGINSDIR/app-64.7z'), 'archive fixture');
    } else {
      fs.cpSync(app, destination, { recursive: true });
      await modify(destination, kind);
    }
  } };
  return { root, installerRoot, harnessArtifact, outputDirectory, calls, tools, options: { installerRoot, harnessArtifact, outputDirectory, version: '0.3.4' } };
}

function noScratch(f) { assert.equal(fs.readdirSync(f.outputDirectory).some(name => name.startsWith('.verify-installer-')), false); }

test('both final executables verify actual ASAR version, frozen nested Harness, and filtered inventories', async t => {
  const f = await fixture(t), result = await verifyWindowsInstaller(f.options, f.tools);
  assert.equal(f.calls.length, 4); assert.deepEqual(result.artifacts.map(a => a.kind), ['setup', 'portable']);
  assert.equal(result.signed, false); assert.equal(result.nativeBoot, 'not-verified');
  for (const artifact of result.artifacts) {
    assert.equal(artifact.inventories.skills.files, 3);
    assert.equal(artifact.inventories.codex.files, 1);
    assert.equal(artifact.inventories.node.files, 2, 'uses the actual builder filters');
    assert.equal(artifact.nestedHarness.size, 512);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  noScratch(f);
});

test('portable payload is independently verified and changes never print configuration contents', async t => {
  const f = await fixture(t, (app, kind) => { if (kind === 'portable') fs.writeFileSync(path.join(app, 'resources/managed-config.json'), '{"private":"changed secret"}'); });
  await assert.rejects(verifyWindowsInstaller(f.options, f.tools), error => {
    assert.match(error.message, /portable.*configuration payload differs/);
    assert.ok(!error.message.includes('secret')); return true;
  });
  assert.equal(f.calls.length, 4); noScratch(f);
});

test('rejects missing, changed, and extra vendor entries including unselected platform siblings', async t => {
  for (const modify of [
    app => fs.rmSync(path.join(app, 'resources/vendor/skills/skill/SKILL.md')),
    app => fs.writeFileSync(path.join(app, 'resources/vendor/skills/extra'), 'extra'),
    app => fs.writeFileSync(path.join(app, 'resources/vendor/t3code-desktop/win-x64/TritonAI-Harness-0.3.4-x64.exe'), pe(true)),
    app => fs.mkdirSync(path.join(app, 'resources/vendor/codex-cli/unselected-platform')),
  ]) {
    const f = await fixture(t, modify);
    await assert.rejects(verifyWindowsInstaller(f.options, f.tools), /payload differs|unexpected vendor payload/);
    noScratch(f);
  }
});

test('rejects filesystem links even when they point to identical payload bytes', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, app => {
    const file = path.join(app, 'resources/vendor/skills/skill/SKILL.md');
    fs.renameSync(file, file + '.original'); fs.symlinkSync('SKILL.md.original', file);
  });
  await assert.rejects(verifyWindowsInstaller(f.options, f.tools), /symlink/); noScratch(f);
});

test('rejects wrong versions, invalid PE, and a different prepared Harness before success', async t => {
  const version = await fixture(t, undefined, '0.3.5');
  await assert.rejects(verifyWindowsInstaller(version.options, version.tools), /wrong version/); noScratch(version);
  const invalid = await fixture(t); fs.writeFileSync(path.join(invalid.outputDirectory, 'TritonAI-Installer-Setup-0.3.4-x64.exe'), 'MZ');
  await assert.rejects(verifyWindowsInstaller(invalid.options, invalid.tools), /Invalid Windows executable/); noScratch(invalid);
  const harness = await fixture(t); fs.appendFileSync(harness.harnessArtifact, 'changed');
  await assert.rejects(verifyWindowsInstaller(harness.options, harness.tools), /Prepared nested Harness differs/);
  assert.equal(harness.calls.length, 0);
});

test('archive extraction rejects traversal, aliases, and links before writing entries', () => {
  assert.doesNotThrow(() => validateArchiveListing('Path = $PLUGINSDIR/app-64.7z\nSize = 123\n'));
  for (const name of ['../escape', '/absolute', 'C:/drive', 'a/./b', 'a//b', 'a\\..\\b']) assert.throws(() => validateArchiveListing(`Path = ${name}\nSize = 1`), /unsafe path/);
  assert.throws(() => validateArchiveListing('Path = payload\n\nPath = PAYLOAD'), /duplicate paths/);
  assert.throws(() => validateArchiveListing('Path = payload\nSymbolic Link = outside'), /contains a link/);
  assert.throws(() => validateArchiveListing('Path = payload\nHard Link = outside'), /contains a link/);
});
