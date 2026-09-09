const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { verifyPluginArchive } = require('./local-release-payload.cjs');
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const asar = builderRequire('@electron/asar');

async function fixture(t, modify = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), plugins = path.join(source, 'production-integrations');
  fs.mkdirSync(path.join(plugins, 'packages/github'), { recursive: true });
  const bytes = Buffer.from('frozen plugin bytes');
  const composition = { packages: [{ id: 'github', files: [{ path: 'index.js', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] }] };
  fs.writeFileSync(path.join(plugins, 'manifest.json'), JSON.stringify(composition));
  fs.writeFileSync(path.join(plugins, 'packages/github/index.js'), bytes);
  modify(plugins);
  const archive = path.join(root, 'payload.asar');
  await asar.createPackage(source, archive);
  return { archive, composition };
}

test('actual ASAR plugin bytes match the frozen manifest', async t => {
  const { archive, composition } = await fixture(t);
  assert.deepEqual(verifyPluginArchive(archive, asar, composition), { files: 1, pluginIds: ['github'] });
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
