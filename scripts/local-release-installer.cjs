'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { fileHash } = require('./release-runner.cjs');
const { runTool } = require('./local-release-windows.cjs');

const RESOURCES = {
  harness: ['vendor/t3code-desktop/win-x64', 'vendor/t3code-desktop/win-x64'],
  skills: ['vendor/skills', 'vendor/skills'],
  codex: ['vendor/codex-cli/win-x64', 'vendor/codex-cli/win-x64'],
  node: ['vendor/node-runtime/win-x64', 'vendor/node-runtime/win-x64'],
  configuration: ['build/managed-config.generated.json', 'managed-config.json'],
  composition: ['build/managed-plugin-composition.generated.json', 'managed-plugin-composition.json'],
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function regularPath(root, relative) {
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Packaged input must not be a symlink: ${relative}`);
  }
  return file;
}

async function inventory(root, filter = () => true) {
  const entries = [];
  async function visit(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Payload tree contains a symlink: ${relative || path.basename(root)}`);
    if (!filter(file, stat)) return;
    if (stat.isDirectory()) {
      if (relative) entries.push({ path: relative, directory: true });
      for (const name of fs.readdirSync(file).sort()) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push({ path: relative, size: stat.size, sha256: await fileHash(file) });
    else throw new Error(`Payload tree contains a non-file: ${relative}`);
  }
  await visit(root, '');
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function assertPE(file, { unsigned = false, x64 = false } = {}) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular Windows executable: ${path.basename(file)}`);
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('Missing DOS header');
    const offset = header.readUInt32LE(60), pe = Buffer.alloc(264);
    if (offset < 64 || offset > fs.fstatSync(fd).size - pe.length || fs.readSync(fd, pe, 0, pe.length, offset) !== pe.length
      || pe.toString('ascii', 0, 4) !== 'PE\0\0') throw new Error('Invalid PE header');
    const magic = pe.readUInt16LE(24), machine = pe.readUInt16LE(4);
    if (![0x10b, 0x20b].includes(magic) || (x64 && (magic !== 0x20b || machine !== 0x8664))) throw new Error('Unexpected PE architecture');
    const security = 24 + (magic === 0x20b ? 112 : 96) + 4 * 8;
    if (unsigned && (pe.readUInt32LE(security) || pe.readUInt32LE(security + 4))) throw new Error('Expected an unsigned release executable');
    return { machine, format: magic === 0x20b ? 'PE32+' : 'PE32' };
  } catch (error) { throw new Error(`Invalid Windows executable ${path.basename(file)}: ${error.message}`); }
  finally { fs.closeSync(fd); }
}

function validateArchiveListing(listing) {
  const seen = new Set();
  for (const block of listing.trim().split(/\r?\n\r?\n/)) {
    const name = block.match(/^Path = (.+)$/m)?.[1];
    if (!name || /[\x00-\x1f:]/.test(name) || name.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Windows archive contains an unsafe path.');
    const key = name.replaceAll('\\', '/').toLowerCase();
    if (seen.has(key)) throw new Error('Windows archive contains duplicate paths.');
    seen.add(key);
    if (/^(?:Symbolic Link|Hard Link) = .+/m.test(block) || /^Attributes = .*\bl[rwxStTs-]{9}\b/m.test(block)) throw new Error('Windows archive contains a link.');
  }
  if (!seen.size) throw new Error('Windows archive is empty.');
}

async function defaultTools(installerRoot) {
  const installerRequire = createRequire(path.join(installerRoot, 'package.json'));
  const builderRequire = createRequire(installerRequire.resolve('app-builder-lib/package.json'));
  const sevenZip = await builderRequire('./out/toolsets/7zip.js').getPath7za();
  return {
    asar: builderRequire('@electron/asar'), FileMatcher: builderRequire('./out/fileMatcher.js').FileMatcher,
    extract: async (archive, destination) => {
      validateArchiveListing(execFileSync(sevenZip, ['l', '-slt', '-ba', archive], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 }));
      await runTool(sevenZip, ['x', '-y', '-bd', '-bso0', '-bsp0', `-o${destination}`, archive], { timeout: 300000, label: `Extract ${path.basename(archive)}`, log: console.log });
    },
  };
}

async function expectedResources(installerRoot, FileMatcher) {
  const configuration = JSON.parse(fs.readFileSync(path.join(installerRoot, 'electron-builder.win.json'), 'utf8'));
  const expected = {};
  for (const [id, [from, to]] of Object.entries(RESOURCES)) {
    const mappings = configuration.extraResources?.filter(entry => entry.from === from && entry.to === to) || [];
    if (mappings.length !== 1) throw new Error(`Installer builder configuration must map required ${id} payload exactly once.`);
    const source = regularPath(installerRoot, from), matcher = new FileMatcher(source, to, value => value, mappings[0].filter);
    if (matcher.isEmpty() || matcher.containsOnlyIgnore()) matcher.prependPattern('**/*');
    const entries = await inventory(source, matcher.createFilter());
    if (!entries.some(entry => !entry.directory)) throw new Error(`Prepared ${id} payload is empty.`);
    expected[id] = { destination: to, entries, sha256: digest(entries), files: entries.filter(entry => !entry.directory).length };
  }
  return expected;
}

async function verifyWindowsInstaller({ installerRoot, harnessArtifact, version, outputDirectory = path.join(installerRoot, 'artifacts/windows-installer') }, injectedTools) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('A stable Installer version is required.');
  const { asar, FileMatcher, extract } = injectedTools || await defaultTools(installerRoot);
  assertPE(harnessArtifact);
  const harnessHash = await fileHash(harnessArtifact), expected = await expectedResources(installerRoot, FileMatcher);
  const vendorEntries = new Map();
  for (const input of Object.values(expected).filter(input => input.destination.startsWith('vendor/'))) {
    const prefix = input.destination.slice('vendor/'.length);
    for (let dir = prefix; dir !== '.'; dir = path.posix.dirname(dir)) vendorEntries.set(dir, { path: dir, directory: true });
    for (const entry of input.entries) vendorEntries.set(`${prefix}/${entry.path}`, { ...entry, path: `${prefix}/${entry.path}` });
  }
  const vendorIdentity = digest([...vendorEntries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const nestedName = `TritonAI-Harness-${version}-x64.exe`;
  const preparedHarness = expected.harness.entries.filter(entry => entry.path.endsWith('.exe'));
  if (preparedHarness.length !== 1 || preparedHarness[0].path !== nestedName || preparedHarness[0].sha256 !== harnessHash) throw new Error('Prepared nested Harness differs from the verified Harness artifact.');
  const artifacts = [];
  for (const [kind, name] of [['setup', `TritonAI-Installer-Setup-${version}-x64.exe`], ['portable', `TritonAI-Installer-${version}-x64-portable.exe`]]) {
    const artifact = regularPath(outputDirectory, name);
    const pe = assertPE(artifact, { unsigned: true }), outerHash = await fileHash(artifact);
    const scratch = fs.mkdtempSync(path.join(outputDirectory, '.verify-installer-'));
    try {
      const outer = path.join(scratch, 'outer'), app = path.join(scratch, 'app');
      await extract(artifact, outer);
      const inner = regularPath(outer, '$PLUGINSDIR/app-64.7z');
      if (!fs.lstatSync(inner).isFile()) throw new Error('Final Installer is missing its regular app-64.7z payload.');
      await extract(inner, app);
      assertPE(regularPath(app, 'TritonAI Installer.exe'), { x64: true });
      const resources = regularPath(app, 'resources'), archive = regularPath(resources, 'app.asar');
      const pkgEntry = asar.statFile(archive, 'package.json', false);
      if (Object.hasOwn(pkgEntry, 'link') || pkgEntry.files || pkgEntry.unpacked) throw new Error('Installer ASAR package.json must be a regular packed file.');
      if (JSON.parse(asar.extractFile(archive, 'package.json')).version !== version) throw new Error('Final Installer ASAR has the wrong version.');
      const inventories = {};
      for (const [id, input] of Object.entries(expected)) {
        const actual = await inventory(regularPath(resources, input.destination));
        if (digest(actual) !== input.sha256) throw new Error(`Final ${kind} Installer ${id} payload differs from prepared inputs (missing, extra, or changed entries).`);
        inventories[id] = { files: input.files, sha256: input.sha256 };
      }
      if (digest(await inventory(regularPath(resources, 'vendor'))) !== vendorIdentity) throw new Error(`Final ${kind} Installer contains an unexpected vendor payload.`);
      const nested = regularPath(resources, `${expected.harness.destination}/${nestedName}`);
      assertPE(nested);
      if (await fileHash(nested) !== harnessHash) throw new Error('Final Installer nested Harness differs from the verified artifact.');
      if (await fileHash(artifact) !== outerHash) throw new Error('Installer executable changed during verification.');
      artifacts.push({ kind, path: artifact, size: fs.statSync(artifact).size, sha256: outerHash, pe, nestedHarness: { sha256: harnessHash, size: fs.statSync(nested).size }, inventories });
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  return { schemaVersion: 1, version, archiveVerified: true, signed: false, nativeBoot: 'not-verified', artifacts };
}

module.exports = { verifyWindowsInstaller, inventory, validateArchiveListing };
