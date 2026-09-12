const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('node:child_process');

function safeRelativePath(value) {
  return typeof value === 'string' && /^[\x20-\x7e]+$/.test(value)
    && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function assertRecordKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid frozen plugin ${label}.`);
}

function validateFrozenComposition(composition) {
  assertRecordKeys(composition, ['version', 'kind', 'source', 'packages'], 'composition');
  assertRecordKeys(composition.source, ['repository', 'ref', 'commit'], 'source');
  const { source } = composition;
  const commit = /^[a-f0-9]{40}$/;
  if (composition.version !== 1 || composition.kind !== 'tritonai-harness-plugin-composition'
    || source.repository !== 'https://github.com/dbalders/TritonAI-Plugins.git'
    || typeof source.commit !== 'string' || !commit.test(source.commit)
    || typeof source.ref !== 'string'
    || !(commit.test(source.ref) || /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(source.ref))
    || source.ref.includes('..') || source.ref.includes('@{') || source.ref.includes('//')
    || /(?:\/|\.|\.lock)$/.test(source.ref) || (commit.test(source.ref) && source.ref !== source.commit)
    || !Array.isArray(composition.packages) || !composition.packages.length) {
    throw new Error('Invalid frozen plugin composition identity.');
  }
  let previousId = '';
  for (const plugin of composition.packages) {
    assertRecordKeys(plugin, ['id', 'name', 'version', 'digest', 'files'], 'package');
    if (typeof plugin.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(plugin.id)
      || plugin.id <= previousId || plugin.name !== `@tritonai/plugin-${plugin.id}`
      || typeof plugin.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(plugin.version)
      || typeof plugin.digest !== 'string' || !/^[a-f0-9]{64}$/.test(plugin.digest)
      || !Array.isArray(plugin.files) || !plugin.files.length || plugin.files.length > 512) {
      throw new Error('Frozen plugin composition contains invalid, unsorted, or duplicate packages.');
    }
    previousId = plugin.id;
    let previousPath = '', totalBytes = 0;
    for (const file of plugin.files) {
      assertRecordKeys(file, ['path', 'size', 'sha256'], 'file');
      if (!safeRelativePath(file.path) || file.path <= previousPath
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 8 * 1024 * 1024
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error('Frozen plugin composition contains unsafe, duplicate, or invalid files.');
      }
      previousPath = file.path;
      totalBytes += file.size;
    }
    if (totalBytes > 64 * 1024 * 1024) throw new Error('Frozen plugin package exceeds the size limit.');
  }
}

function archiveEntries(archive, asar) {
  const entries = asar.listPackage(archive).map(name => name.replace(/^[/\\]/, '').replaceAll('\\', '/'));
  if (entries.some(name => /[\x00-\x1f:]/.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..'))
    || new Set(entries).size !== entries.length) {
    throw new Error('Packaged archive contains unsafe or duplicate paths.');
  }
  return entries;
}

function packageRoots(entries) {
  const roots = new Set();
  for (const name of entries) {
    const parts = name.split('/');
    for (let index = 0; index < parts.length; index++) {
      if (parts[index] === 'production-integrations') roots.add(`${parts.slice(0, index + 1).join('/')}/packages`);
    }
  }
  return [...roots];
}

function findPluginPackageRoots(archive, asar) {
  return packageRoots(archiveEntries(archive, asar));
}

function verifyPluginArchive(archive, asar, composition, expectedRoot) {
  if (!safeRelativePath(expectedRoot)) throw new Error('An explicit safe packaged plugin runtime root is required.');
  validateFrozenComposition(composition);
  const entries = archiveEntries(archive, asar), roots = packageRoots(entries);
  if (roots.length !== 1) throw new Error('Expected exactly one packaged plugin package root.');
  if (roots[0] !== expectedRoot) throw new Error(`Packaged plugins are outside the expected runtime root: ${expectedRoot}`);
  const root = roots[0], integrationRoot = path.posix.dirname(root);
  const expected = new Set(), directories = new Set();
  function requireParents(name) {
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
  }
  for (const plugin of composition.packages) for (const file of plugin.files) {
    const name = `${root}/${plugin.id}/${file.path}`;
    expected.add(name);
    requireParents(name);
  }
  const stat = name => asar.statFile(archive, path.normalize(name), false);
  for (const name of directories) {
    if (!entries.includes(name)) throw new Error(`Missing packaged plugin directory: ${name}`);
    const entry = stat(name);
    if (Object.hasOwn(entry, 'link') || !entry.files) throw new Error(`Packaged plugin directory is not regular: ${name}`);
  }
  const manifest = `${integrationRoot}/manifest.json`;
  if (entries.includes(manifest)) {
    const entry = stat(manifest);
    if (Object.hasOwn(entry, 'link') || entry.files) throw new Error('Packaged plugin manifest is not regular.');
    if (!isDeepStrictEqual(JSON.parse(asar.extractFile(archive, path.normalize(manifest))), composition)) {
      throw new Error('Packaged plugin manifest differs from frozen input.');
    }
  }
  for (const plugin of composition.packages) {
    const digest = crypto.createHash('sha256');
    for (const file of plugin.files) {
      const name = `${root}/${plugin.id}/${file.path}`;
      if (!entries.includes(name)) throw new Error(`Missing packaged plugin file: ${plugin.id}/${file.path}`);
      const entry = stat(name);
      if (Object.hasOwn(entry, 'link') || entry.files) throw new Error(`Packaged plugin file is not regular: ${plugin.id}/${file.path}`);
      const bytes = asar.extractFile(archive, path.normalize(name));
      if (entry.size !== file.size || bytes.length !== file.size
        || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error(`Packaged plugin file differs from frozen input: ${plugin.id}/${file.path}`);
      }
      digest.update(file.path).update('\0').update(String(file.size)).update('\0').update(bytes).update('\0');
    }
    if (digest.digest('hex') !== plugin.digest) throw new Error(`Packaged plugin package digest differs: ${plugin.id}`);
  }
  for (const name of entries.filter(name => name === integrationRoot || name.startsWith(`${integrationRoot}/`))) {
    if (!expected.has(name) && !directories.has(name) && name !== manifest) {
      throw new Error(`Unexpected packaged plugin entry: ${name}`);
    }
  }
  return { files: expected.size, pluginIds: composition.packages.map(p => p.id) };
}

function verifyWindowsPluginArchives(resources, asar, composition) {
  const desktop = path.join(resources, 'app.asar'), server = path.join(resources, 'server.asar');
  for (const archive of [desktop, server]) {
    if (!fs.existsSync(archive) || !fs.lstatSync(archive).isFile()) {
      throw new Error(`Windows payload requires a regular ${path.basename(archive)} archive.`);
    }
  }
  if (findPluginPackageRoots(desktop, asar).length > 0) {
    throw new Error('Windows plugin packages must be in server.asar, not app.asar.');
  }
  return verifyPluginArchive(server, asar, composition, 'apps/server/dist/production-integrations/packages');
}

async function verifyWindowsHarness({ artifact, outputDirectory, composition, version, harnessRoot, installerRoot }) {
  const builderRequire = createRequire(require('./local-release-packaging.cjs').packagingLibrary({ harnessRoot, installerRoot }));
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
    const plugins = verifyWindowsPluginArchives(resources, asar, composition);
    return { schemaVersion: 1, version, plugins, archiveVerified: true, nativeBoot: 'not-verified', signed: false };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
module.exports = { findPluginPackageRoots, verifyPluginArchive, verifyWindowsPluginArchives, verifyWindowsHarness };
