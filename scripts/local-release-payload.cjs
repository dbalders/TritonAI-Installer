const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('node:child_process');

function verifyPluginArchive(archive, asar, composition) {
  const entries = asar.listPackage(archive).map(name => name.replace(/^[/\\]/, '').replaceAll('\\', '/'));
  const manifests = entries.filter(name => name.endsWith('production-integrations/manifest.json'));
  if (manifests.length !== 1) throw new Error('Expected one actual packaged plugin manifest.');
  const manifest = manifests[0], root = manifest.slice(0, -'manifest.json'.length);
  if (!isDeepStrictEqual(JSON.parse(asar.extractFile(archive, path.normalize(manifest))), composition)) throw new Error('Packaged Windows plugin manifest differs from frozen input.');
  const expected = new Set();
  for (const plugin of composition.packages) for (const file of plugin.files) {
    const name = `${root}packages/${plugin.id}/${file.path}`;
    expected.add(name);
    const stat = asar.statFile(archive, path.normalize(name), false);
    if (stat.link || stat.files) throw new Error(`Packaged Windows plugin file is not regular: ${plugin.id}/${file.path}`);
    const bytes = asar.extractFile(archive, path.normalize(name));
    if (bytes.length !== file.size || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Packaged Windows plugin file differs: ${plugin.id}/${file.path}`);
  }
  for (const name of entries.filter(name => name.startsWith(`${root}packages/`))) {
    const stat = asar.statFile(archive, path.normalize(name), false);
    if (!stat.files && !expected.has(name)) throw new Error(`Unexpected packaged Windows plugin file: ${name}`);
  }
  return { files: expected.size, pluginIds: composition.packages.map(p => p.id) };
}

async function verifyWindowsHarness({ artifact, outputDirectory, composition, version, installerRoot }) {
  const installerRequire = createRequire(path.join(installerRoot, 'package.json'));
  const builderRequire = createRequire(installerRequire.resolve('app-builder-lib/package.json'));
  const asar = builderRequire('@electron/asar');
  const sevenZip = await builderRequire('./out/toolsets/7zip.js').getPath7za();
  const header = Buffer.alloc(64), fd = fs.openSync(artifact, 'r');
  try { fs.readSync(fd, header, 0, 64, 0); } finally { fs.closeSync(fd); }
  if (header.toString('ascii', 0, 2) !== 'MZ') throw new Error('Harness Windows output is not a PE executable.');
  const scratch = fs.mkdtempSync(path.join(outputDirectory, '.verify-windows-'));
  try {
    execFileSync(sevenZip, ['x', '-y', '-bd', `-o${scratch}`, artifact], { stdio: 'inherit' });
    const inner = path.join(scratch, '$PLUGINSDIR', 'app-64.7z');
    if (!fs.statSync(inner).isFile()) throw new Error('Windows NSIS output is missing app-64.7z.');
    const app = path.join(scratch, 'app');
    execFileSync(sevenZip, ['x', '-y', '-bd', `-o${app}`, inner], { stdio: 'inherit' });
    const resources = path.join(app, 'resources'), desktop = path.join(resources, 'app.asar');
    if (JSON.parse(asar.extractFile(desktop, 'package.json')).version !== version) throw new Error('Windows Harness payload has the wrong version.');
    const containers = [desktop, path.join(resources, 'server.asar')].filter(file => fs.existsSync(file));
    const pluginContainers = containers.filter(file => asar.listPackage(file).some(name => name.replaceAll('\\', '/').endsWith('production-integrations/manifest.json')));
    if (pluginContainers.length !== 1) throw new Error('Windows payload must contain exactly one plugin composition.');
    const plugins = verifyPluginArchive(pluginContainers[0], asar, composition);
    return { schemaVersion: 1, version, plugins, archiveVerified: true, nativeBoot: 'not-verified', signed: false };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
module.exports = { verifyPluginArchive, verifyWindowsHarness };
