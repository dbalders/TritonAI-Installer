'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const NSIS_VERSION = '3.0.4.1';
const NSIS_SHA256 = 'e277b7378931b74392015f5ad6b1d744dcd8a347baa4480350a75ebeab8d8e3d';
const NSIS_ARCHIVE_SHA256 = '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa';
const RESOURCES_ARCHIVE_SHA256 = '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103';
const BUILDER_VERSION = '26.15.7';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function run(file, args, { env, cwd, input, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${path.basename(file)} failed (${signal || code}): ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.on('error', () => {}); // An early child failure is reported by close.
    child.stdin.end(input);
  });
}

function ownPath(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Windows toolchain path must be inside its candidate root: ${file}`);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Windows toolchain cache must not contain symlinks: ${current}`);
    }
  }
  return file;
}

function hashTree(directory) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in NSIS inputs: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push([path.relative(directory, file).split(path.sep).join('/'), sha256(file)]);
    }
  }
  visit(directory);
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function verifyCacheIsolation(root, directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // The official 7-Zip bundle includes bin/7za -> 7zz. Such internal links
      // are safe; a link outside this candidate must fail before a cache write.
      const target = fs.realpathSync(file);
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Windows toolchain cache symlink escapes its candidate: ${file}`);
      }
    } else if (entry.isDirectory()) verifyCacheIsolation(root, file);
  }
}

function verifyCompiler(compiler) {
  const actual = sha256(compiler);
  if (actual !== NSIS_SHA256) {
    throw new Error(`NSIS ${NSIS_VERSION} compiler hash mismatch at ${compiler}: expected ${NSIS_SHA256}, got ${actual}. Start a fresh candidate toolchain cache; no shared cache was changed.`);
  }
}

// NSIS runs as a Windows program: convert Unix absolute paths, including those
// embedded in stdin scripts and command-line defines. Leave /LANG, /S and URLs intact.
function translatePaths(value, mappings) {
  for (const [source, destination] of [...mappings].sort((a, b) => b[0].length - a[0].length)) {
    value = value.split('Z:' + source + '/').join(destination + '/');
    value = value.split('Z:' + source.replaceAll('/', '\\') + '\\').join(destination.replaceAll('/', '\\') + '\\');
    value = value.split(source + '/').join(destination + '/');
    value = value.split('"' + source + '"').join('"' + destination + '"');
    if (value.endsWith('=' + source)) value = value.slice(0, -source.length) + destination;
  }
  value = value.replace(/(^|[\s"'=])\/(?![/*])(?=[^/\s"']+\/)/g, '$1Z:/');
  return value.replace(/[a-z]:\/(?!\/)[^"'\r\n]*/gi, match => match.replaceAll('/', '\\'));
}

function launcherSource({ compiler, compilerSha256, wine, nsisRoot, templates, templateSource, root, prefix, candidateRoot = root }) {
  return `'use strict';\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst crypto = require('node:crypto');\nconst {spawnSync} = require('node:child_process');\nconst sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');\nconst config = ${JSON.stringify({ compiler, compilerSha256, wine, nsisRoot, templates, templateSource, root, prefix, candidateRoot })};\n${translatePaths.toString()}\n${hashTree.toString()}\nif (sha256(config.compiler) !== config.compilerSha256) { console.error('Pinned NSIS compiler changed; prepare a fresh candidate toolchain.'); process.exit(1); }\nconst mappings = [[config.templateSource, 'T:/templates'], [config.root, 'T:'], [config.candidateRoot, 'U:']];\n// Harness and Installer have separate node_modules. Builder invokes us from its\n// NSIS template directory; require identical templates before using our short copy.\nif (fs.existsSync(path.join(process.cwd(), 'installer.nsi'))) {\n  if (hashTree(process.cwd()) !== hashTree(config.templates)) { console.error('Harness/Installer NSIS templates differ from the pinned toolchain.'); process.exit(1); }\n  mappings.unshift([process.cwd(), 'T:/templates']);\n}\nconst args = process.argv.slice(2).map(arg => translatePaths(arg, mappings));\nconst script = args.includes('-') ? translatePaths(fs.readFileSync(0, 'utf8'), mappings) : undefined;\nconst env = {...process.env, WINEPREFIX:config.prefix, NSISDIR:translatePaths(config.nsisRoot + '/', mappings)};\nconst result = spawnSync(config.wine, [config.compiler, ...args], {cwd:config.templates, env, input:script, encoding:'utf8', stdio:script === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], maxBuffer:64 * 1024 * 1024});\nif (result.error) console.error(result.error.message);\nprocess.exit(result.status ?? 1);\n`;
}

function findWine(wine, env) {
  const candidates = wine ? [wine] : [
    ...String(env.PATH || '').split(path.delimiter).flatMap(dir => ['wine64', 'wine'].map(name => path.join(dir, name))),
    '/usr/local/bin/wine64', '/opt/homebrew/bin/wine64',
  ];
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); return path.resolve(file); } catch {}
  }
  throw new Error('Windows cross-build requires Wine. Install Wine, or set the local release profile wine path to its wine64 executable.');
}

/** Prepare an isolated Windows cross-build lane. Never changes process.env or shared caches.
 * root is the candidate-owned toolchains/win directory; installerRoot has npm ci completed.
 * Return only the environment overlay (safe to save) and deterministic input receipt.
 */
async function prepareWindowsToolchain({ root, installerRoot, candidateRoot, wine, env = process.env, log = () => {} }) {
  if (process.platform !== 'darwin') throw new Error('This local cross-build toolchain requires macOS.');
  if (!path.isAbsolute(root || '') || !path.isAbsolute(installerRoot || '')) {
    throw new Error('Windows toolchain root and installerRoot must be absolute paths.');
  }
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Windows toolchain root must not be a symlink.');
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  if (candidateRoot !== undefined && !path.isAbsolute(candidateRoot)) throw new Error('candidateRoot must be an absolute path.');
  candidateRoot = candidateRoot ? fs.realpathSync(candidateRoot) : root;
  const relativeRoot = path.relative(candidateRoot, root);
  if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) throw new Error('Windows toolchain root must be inside candidateRoot.');
  const cache = ownPath(root, path.join(root, 'cache'));
  const prefix = ownPath(root, path.join(root, 'wineprefix'));
  const bin = ownPath(root, path.join(root, 'bin'));
  const templates = ownPath(root, path.join(root, 'templates'));
  for (const dir of [cache, prefix, bin]) fs.mkdirSync(dir, { recursive: true });
  // Check before the downloader touches a resumed cache. An unexpected symlink
  // must never redirect even its download/extraction writes to a shared cache.
  verifyCacheIsolation(root, cache);
  const winePath = findWine(wine, env);
  let packageFile, downloader;
  try {
    packageFile = require.resolve('app-builder-lib/package.json', { paths: [installerRoot] });
    downloader = require.resolve('app-builder-lib/out/util/electronGet', { paths: [installerRoot] });
  } catch { throw new Error(`Run npm ci in ${installerRoot} before preparing the Windows toolchain.`); }
  const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
  if (version !== BUILDER_VERSION) throw new Error(`Windows toolchain expects app-builder-lib ${BUILDER_VERSION}, found ${version}. Validate the pinned NSIS integration before changing the release toolchain version.`);
  const templateSource = path.join(path.dirname(packageFile), 'templates', 'nsis');
  const templateSha256 = hashTree(templateSource);
  const childEnv = { ...env, ELECTRON_BUILDER_CACHE: cache, WINEPREFIX: prefix, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'winemenubuilder.exe=d' };
  for (const key of Object.keys(childEnv)) {
    if (/^(ELECTRON_BUILDER_NSIS|ELECTRON_BUILDER_WINE|NSISDIR$|WINEARCH$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete childEnv[key];
  }
  log('Preparing pinned Windows NSIS compiler and resources in the candidate cache.');
  const code = `const {downloadBuilderToolset} = require(${JSON.stringify(downloader)}); (async () => { const result = []; for (const [releaseName, sha256] of ${JSON.stringify([['nsis-' + NSIS_VERSION, NSIS_ARCHIVE_SHA256], ['nsis-resources-3.4.1', RESOURCES_ARCHIVE_SHA256]])}) {const filenameWithExt=releaseName+'.7z';result.push(await downloadBuilderToolset({releaseName,filenameWithExt,checksums:{[filenameWithExt]:sha256},overrideUrl:'https://github.com/electron-userland/electron-builder-binaries/releases/download/'+releaseName}));} console.log(JSON.stringify(result)); })().catch(error => { console.error(error.message); process.exitCode=1; });`;
  const output = await run(process.execPath, ['-e', code], { env: childEnv, cwd: installerRoot, timeout: 300000 });
  const [nsisRoot, resources] = JSON.parse(output.split('\n').at(-1));
  ownPath(root, nsisRoot);
  ownPath(root, resources);
  const compiler = ownPath(root, path.join(nsisRoot, 'Bin', 'makensis.exe'));
  verifyCompiler(compiler); // Repeat even when the downloader reports a cache hit.
  for (const [release, expected] of [['nsis-' + NSIS_VERSION, NSIS_ARCHIVE_SHA256], ['nsis-resources-3.4.1', RESOURCES_ARCHIVE_SHA256]]) {
    const archive = ownPath(root, path.join(cache, release, release + '.7z'));
    if (sha256(archive) !== expected) throw new Error(`Pinned NSIS archive hash mismatch: ${archive}`);
  }
  const resourcesSha256 = hashTree(resources);
  if (fs.existsSync(templates)) {
    if (hashTree(templates) !== templateSha256) throw new Error(`Candidate NSIS templates changed: ${templates}. Start a fresh candidate toolchain cache.`);
  } else fs.cpSync(templateSource, templates, { recursive: true });
  const wineVersion = await run(winePath, ['--version'], { env: childEnv, timeout: 30000 });
  // Wine's short drive avoids legacy NSIS MAX_PATH failures in long worktree paths.
  // dosdevices is Wine-owned; the one deliberate mapping belongs to this prefix only.
  const devices = ownPath(root, path.join(prefix, 'dosdevices'));
  fs.mkdirSync(devices, { recursive: true });
  for (const [letter, target] of [['t:', root], ['u:', candidateRoot]]) {
    const drive = path.join(devices, letter);
    try { if (fs.readlinkSync(drive) !== target) throw new Error(`Candidate Wine ${letter} drive points at another directory.`); }
    catch (error) { if (error.code === 'ENOENT') fs.symlinkSync(target, drive); else throw error; }
  }
  const nodeLauncher = ownPath(root, path.join(bin, 'makensis.cjs'));
  const launcher = launcherSource({ compiler, compilerSha256: NSIS_SHA256, wine: winePath, nsisRoot, templates, templateSource, root, prefix, candidateRoot });
  fs.writeFileSync(nodeLauncher, launcher);
  const macLauncher = ownPath(root, path.join(nsisRoot, 'mac', 'makensis'));
  fs.writeFileSync(macLauncher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nodeLauncher)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(macLauncher, 0o755);
  fs.writeFileSync(ownPath(root, path.join(bin, 'wine')), `#!/bin/sh\nexec ${quote(winePath)} "$@"\n`, { mode: 0o755 });
  const overlay = {
    ELECTRON_BUILDER_CACHE: cache,
    WINEPREFIX: prefix,
    WINEDEBUG: '-all',
    WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
    USE_SYSTEM_WINE: 'true',
    ELECTRON_BUILDER_WINE_TOOLSET_DIR: '',
    WINEARCH: 'win64',
    ELECTRON_BUILDER_NSIS_DIR: nsisRoot,
    ELECTRON_BUILDER_NSIS_RESOURCES_DIR: resources,
    ELECTRON_BUILDER_NSIS_TEMPLATE_DIR: templates,
    PATH: bin + path.delimiter + String(env.PATH || ''),
  };
  log('Checking pinned NSIS through Wine with a small stdin-fed compiler probe.');
  const probe = ownPath(root, path.join(root, 'compiler-probe.exe'));
  fs.rmSync(probe, { force: true });
  await run(macLauncher, ['-WX', '-INPUTCHARSET', 'UTF8', '-'], {
    env: { ...childEnv, ...overlay },
    input: `!include "${templateSource}/include/StdUtils.nsh"\nUnicode true\nOutFile "${probe}"\nSection\nDetailPrint "TritonAI toolchain probe"\nSectionEnd\n`,
  });
  const bytes = fs.readFileSync(probe);
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('NSIS compiler probe did not produce a Windows executable.');
  fs.rmSync(probe);
  const receipt = {
    schemaVersion: 1, nsisVersion: NSIS_VERSION, compilerSha256: NSIS_SHA256,
    nsisArchiveSha256: NSIS_ARCHIVE_SHA256, resourcesArchiveSha256: RESOURCES_ARCHIVE_SHA256,
    resourcesSha256, electronBuilderVersion: version, templateSha256,
    wine: { path: winePath, version: wineVersion, sha256: sha256(fs.realpathSync(winePath)) },
    launcherSha256: crypto.createHash('sha256').update(launcher).digest('hex'),
  };
  return { env: overlay, receipt };
}

module.exports = { prepareWindowsToolchain, verifyCompiler, translatePaths, launcherSource, NSIS_SHA256 };
