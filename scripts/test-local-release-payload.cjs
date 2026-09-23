const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { findPluginPackageRoots, verifyPluginArchive: verifyArchiveAtRoot, verifyWindowsPluginArchives } = require('./local-release-payload.cjs');
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const asar = builderRequire('@electron/asar');
const expectedRoot = 'apps/server/dist/production-integrations/packages';
const verifyPluginArchive = (archive, asar, composition) => verifyArchiveAtRoot(archive, asar, composition, expectedRoot);

async function fixture(t, modify = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), plugins = path.join(source, 'apps/server/dist/production-integrations');
  fs.mkdirSync(path.join(plugins, 'packages/github'), { recursive: true });
  const bytes = Buffer.from('frozen plugin bytes');
  const file = { path: 'index.js', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const digest = crypto.createHash('sha256').update(file.path).update('\0').update(String(file.size)).update('\0').update(bytes).update('\0').digest('hex');
  const composition = { version: 1, kind: 'tritonai-harness-plugin-composition', source: {
    repository: 'https://github.com/dbalders/TritonAI-Plugins.git', ref: 'a'.repeat(40), commit: 'a'.repeat(40),
  }, packages: [{ id: 'github', name: '@tritonai/plugin-github', version: '1.0.0', digest, files: [file] }] };
  fs.writeFileSync(path.join(plugins, 'packages/github/index.js'), bytes);
  modify(plugins, source, composition);
  const archive = path.join(root, 'payload.asar');
  await asar.createPackage(source, archive);
  return { archive, composition, root };
}

test('current Harness ASAR packages verify against the external manifest without embedding it', async t => {
  const { archive, composition } = await fixture(t, (_plugins, source) => fs.writeFileSync(path.join(source, 'résumé.txt'), 'unrelated app resource'));
  assert.deepEqual(findPluginPackageRoots(archive, asar), ['apps/server/dist/production-integrations/packages']);
  assert.deepEqual(verifyPluginArchive(archive, asar, composition), { files: 1, pluginIds: ['github'] });
});

test('optional embedded manifest is accepted only when it matches the frozen composition', async t => {
  const matching = await fixture(t, (plugins, _source, composition) => fs.writeFileSync(path.join(plugins, 'manifest.json'), JSON.stringify(composition)));
  assert.equal(verifyPluginArchive(matching.archive, asar, matching.composition).files, 1);
  const mismatched = await fixture(t, plugins => fs.writeFileSync(path.join(plugins, 'manifest.json'), '{}'));
  assert.throws(() => verifyPluginArchive(mismatched.archive, asar, mismatched.composition), /manifest differs/);
  const linked = await fixture(t, (plugins, source, composition) => {
    fs.writeFileSync(path.join(source, 'proof.json'), JSON.stringify(composition));
    fs.symlinkSync('../../../../proof.json', path.join(plugins, 'manifest.json'));
  });
  assert.throws(() => verifyPluginArchive(linked.archive, asar, linked.composition), /manifest is not regular/);
});

test('actual ASAR rejects altered or additional plugin files', async t => {
  const altered = await fixture(t, plugins => fs.writeFileSync(path.join(plugins, 'packages/github/index.js'), 'changed'));
  assert.throws(() => verifyPluginArchive(altered.archive, asar, altered.composition), /file differs/);
  const extra = await fixture(t, plugins => fs.writeFileSync(path.join(plugins, 'packages/github/extra.js'), 'extra'));
  assert.throws(() => verifyPluginArchive(extra.archive, asar, extra.composition), /Unexpected packaged/);
});

test('actual ASAR rejects a symlink even when its target has the expected bytes', async t => {
  const { archive, composition } = await fixture(t, plugins => {
    const original = path.join(plugins, 'packages/github/index.js'), target = path.join(plugins, 'shared.js');
    fs.renameSync(original, target); fs.symlinkSync('../../shared.js', original);
  });
  assert.throws(() => verifyPluginArchive(archive, asar, composition), /not regular/);
});

test('actual ASAR rejects missing files and extra files, packages, and empty directories', async t => {
  const missing = await fixture(t, plugins => fs.rmSync(path.join(plugins, 'packages/github/index.js')));
  assert.throws(() => verifyPluginArchive(missing.archive, asar, missing.composition), /Missing packaged plugin file/);
  for (const name of ['packages/github/empty', 'packages/unselected', 'unlisted']) {
    const extra = await fixture(t, plugins => fs.mkdirSync(path.join(plugins, name), { recursive: true }));
    assert.throws(() => verifyPluginArchive(extra.archive, asar, extra.composition), /Unexpected packaged/);
  }
});

test('actual ASAR requires one complete package root and regular ancestor directories', async t => {
  const duplicate = await fixture(t, (plugins, source) => fs.cpSync(plugins, path.join(source, 'duplicate/production-integrations'), { recursive: true }));
  assert.throws(() => verifyPluginArchive(duplicate.archive, asar, duplicate.composition), /exactly one.*root/);
  const misplaced = await fixture(t, plugins => fs.renameSync(path.join(plugins, 'packages'), path.join(plugins, 'wrong-root')));
  assert.throws(() => verifyPluginArchive(misplaced.archive, asar, misplaced.composition), /Missing packaged plugin directory/);
  const linked = await fixture(t, (plugins, source) => {
    fs.renameSync(path.join(plugins, 'packages'), path.join(source, 'aliased-packages'));
    fs.symlinkSync('../../../../aliased-packages', path.join(plugins, 'packages'));
  });
  assert.throws(() => verifyPluginArchive(linked.archive, asar, linked.composition), /not regular|Missing packaged plugin directory/);
  const noRoot = await fixture(t, plugins => fs.rmSync(plugins, { recursive: true }));
  assert.throws(() => verifyPluginArchive(noRoot.archive, asar, noRoot.composition), /exactly one.*root/);
});

test('identical plugin bytes relocated outside the runtime path cannot pass verification', async t => {
  const relocated = await fixture(t, (plugins, source) => {
    fs.mkdirSync(path.join(source, 'wrong'));
    fs.renameSync(plugins, path.join(source, 'wrong/production-integrations'));
  });
  assert.deepEqual(findPluginPackageRoots(relocated.archive, asar), ['wrong/production-integrations/packages']);
  assert.throws(() => verifyPluginArchive(relocated.archive, asar, relocated.composition), /outside the expected runtime root/);
  const canonical = await fixture(t);
  assert.throws(() => verifyArchiveAtRoot(canonical.archive, asar, canonical.composition), /explicit safe.*runtime root/);
});

test('Windows requires canonical plugins in server.asar and rejects wrong or duplicate containers', async t => {
  const { archive, composition, root } = await fixture(t);
  const emptySource = path.join(root, 'desktop-source');
  fs.mkdirSync(emptySource);
  fs.writeFileSync(path.join(emptySource, 'package.json'), '{"version":"0.3.4"}');
  const emptyArchive = path.join(root, 'desktop.asar');
  await asar.createPackage(emptySource, emptyArchive);
  function resources(name, desktopInput, serverInput) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.copyFileSync(desktopInput, path.join(directory, 'app.asar'));
    if (serverInput) fs.copyFileSync(serverInput, path.join(directory, 'server.asar'));
    return directory;
  }
  assert.deepEqual(verifyWindowsPluginArchives(resources('canonical', emptyArchive, archive), asar, composition), { files: 1, pluginIds: ['github'] });
  assert.throws(() => verifyWindowsPluginArchives(resources('wrong-container', archive, emptyArchive), asar, composition), /must be in server.asar/);
  assert.throws(() => verifyWindowsPluginArchives(resources('duplicate-container', archive, archive), asar, composition), /must be in server.asar/);
  assert.throws(() => verifyWindowsPluginArchives(resources('missing-server', emptyArchive), asar, composition), /requires a regular server.asar/);
});

test('frozen composition rejects unsafe paths, duplicate entries, and invalid package digests', async t => {
  const { archive, composition } = await fixture(t);
  for (const unsafe of ['../outside', '/absolute', 'C:drive', 'nested\\file', 'nested//file']) {
    const changed = structuredClone(composition); changed.packages[0].files[0].path = unsafe;
    assert.throws(() => verifyPluginArchive(archive, asar, changed), /unsafe.*files/);
  }
  const duplicate = structuredClone(composition); duplicate.packages.push(duplicate.packages[0]);
  assert.throws(() => verifyPluginArchive(archive, asar, duplicate), /duplicate packages/);
  const files = structuredClone(composition); files.packages[0].files.push(files.packages[0].files[0]);
  assert.throws(() => verifyPluginArchive(archive, asar, files), /duplicate.*files/);
  const digest = structuredClone(composition); digest.packages[0].digest = 'b'.repeat(64);
  assert.throws(() => verifyPluginArchive(archive, asar, digest), /package digest differs/);
  assert.throws(() => verifyPluginArchive(archive, asar, { packages: composition.packages }), /Invalid frozen plugin/);
});

test('malformed and duplicate ASAR inventory paths cannot alias the expected root', async t => {
  const { archive, composition } = await fixture(t);
  for (const extra of ['/apps/server/dist/../production-integrations/packages', '//production-integrations/packages', '/apps/server/dist/production-integrations/packages']) {
    const malformed = { ...asar, listPackage: file => [...asar.listPackage(file), extra] };
    assert.throws(() => verifyPluginArchive(archive, malformed, composition), /unsafe or duplicate paths/);
  }
});

// The hosted Windows builder bundles 7za without an NSIS decoder. Ensure the
// verifier selects a tool that can read the container, not only embedded data.
test('Harness archive tool supports NSIS and 7z decoding', async () => {
  const { harnessArchiveTool } = require('./local-release-payload.cjs');
  const tool = await harnessArchiveTool(builderRequire);
  const formats = require('node:child_process').execFileSync(tool, ['i'], { encoding: 'utf8' });
  assert.match(formats, /\bNsis\b/);
  assert.match(formats, /\b7z\b/);
});
