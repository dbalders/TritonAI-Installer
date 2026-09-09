'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runTool } = require('./local-release-windows.cjs');

const TARGET = 'x86_64-pc-windows-msvc';
const EXECUTABLE = 't3-resource-monitor.exe';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function inside(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Native build path must be inside its candidate root: ${file}`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Native build path must not contain symlinks: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}

function treeIdentity(directory, ignored = new Set(), internalLinks = false) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (current === directory && ignored.has(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.relative(directory, fs.realpathSync(file));
        if (!internalLinks || target.startsWith('..') || path.isAbsolute(target)) throw new Error(`Unexpected symlink in native build inputs: ${file}`);
        // The official SDK contains version-directory links to '.'. Record the
        // link without recursing into it; all actual files are hashed separately.
        files.push({ path: path.relative(directory, file).split(path.sep).join('/'), link: fs.readlinkSync(file) });
      } else if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push({ path: path.relative(directory, file).split(path.sep).join('/'), sha256: sha256(file), size: fs.statSync(file).size });
      else throw new Error(`Unexpected non-file in native build inputs: ${file}`);
    }
  }
  visit(directory);
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

function verifyWindowsPE(file) {
  const bytes = fs.readFileSync(file);
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset + 26 > bytes.length
    || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b) {
    throw new Error(`Fresh resource monitor is not a Windows x64 PE32+ executable: ${file}`);
  }
  return { path: file, sha256: sha256(file), size: bytes.length, format: 'PE32+', machine: 'x64' };
}

function nativeEnvironment({ bin, clang, cargoHome, cache, rustc, baseEnv = process.env }) {
  const env = { ...baseEnv };
  // Neither a caller's Rust flags nor its shared caches may change this build.
  for (const name of Object.keys(env)) {
    if (/^(?:CARGO_|RUST|XWIN_|TARGET_|CMAKE_|BINDGEN_|CC_|CXX_|AR_)/.test(name)
      || ['CC', 'CXX', 'AR', 'CFLAGS', 'CXXFLAGS', 'CL_FLAGS', 'LIB', 'RCFLAGS'].includes(name)) delete env[name];
  }
  return Object.assign(env, {
    // cargo-xwin 0.23 auto-prepends Homebrew LLVM unless it is already present.
    // Keep it at the end; candidate aliases select the pinned working tools.
    PATH: [bin, path.dirname(clang), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin'].join(path.delimiter),
    CARGO: path.join(bin, 'cargo'),
    RUSTC: rustc,
    CARGO_HOME: cargoHome,
    XWIN_CACHE_DIR: cache,
    XWIN_ARCH: 'x86_64',
    XWIN_VERSION: '17',
    XWIN_CROSS_COMPILER: 'clang-cl',
  });
}

function verifyCachePaths(directory, clang, root = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // cargo-xwin creates this one compiler alias outside the SDK tree.
      const target = fs.realpathSync(file), relative = path.relative(root, target);
      const compilerAlias = file === path.join(root, 'clang-cl') && target === clang;
      if (!compilerAlias && (relative.startsWith('..') || path.isAbsolute(relative))) throw new Error(`Unexpected symlink in candidate native cache: ${file}`);
    } else if (entry.isDirectory()) verifyCachePaths(file, clang, root);
  }
}

async function buildWindowsResourceMonitor({ root, harnessRoot, cargo, rustc, cargoXwin, clang, lldLink, log = console.log }) {
  root = path.resolve(root);
  // cargo-xwin 0.23 rejects whitespace when encoding its SDK library flags.
  // The source worktree may contain spaces; this restriction is on its cache.
  if (/\s/.test(root)) throw new Error(`Windows native cache path cannot contain whitespace with cargo-xwin 0.23: ${root}. Choose a release output directory without spaces.`);
  fs.mkdirSync(root, { recursive: true });
  if (fs.realpathSync(root) !== root) throw new Error(`Native toolchain root must be a real candidate directory, not a symlink: ${root}`);
  harnessRoot = fs.realpathSync(harnessRoot);
  const source = inside(harnessRoot, path.join(harnessRoot, 'native/resource-monitor'));
  const sourceIdentity = treeIdentity(source, new Set(['target']));
  for (const required of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) {
    if (!sourceIdentity.files.some(file => file.path === required)) throw new Error(`Resource monitor source is missing ${required}.`);
  }
  const artifact = inside(harnessRoot, path.join(source, 'target', TARGET, 'release', EXECUTABLE));
  const tools = {};
  for (const [name, file] of Object.entries({ cargo, rustc, cargoXwin, clang, lldLink })) {
    if (!file || !path.isAbsolute(file)) throw new Error(`Pin an absolute ${name} tool path before building the Windows resource monitor.`);
    fs.accessSync(file, fs.constants.X_OK);
    const resolved = fs.realpathSync(file);
    tools[name] = { path: resolved, sha256: sha256(resolved) };
  }
  // Rust's gcc-ld launcher delegates to this sibling executable. Bind both bytes.
  const rustLld = path.resolve(path.dirname(tools.lldLink.path), '..', 'rust-lld');
  if (path.basename(path.dirname(tools.lldLink.path)) === 'gcc-ld') {
    fs.accessSync(rustLld, fs.constants.X_OK);
    tools.rustLld = { path: fs.realpathSync(rustLld), sha256: sha256(rustLld) };
  }
  const bin = inside(root, path.join(root, 'bin'));
  const cache = inside(root, path.join(root, 'cache'));
  const cargoHome = inside(root, path.join(root, 'cargo-home'));
  for (const dir of [bin, cache, cargoHome]) fs.mkdirSync(dir, { recursive: true });
  const aliases = { cargo: tools.cargo.path, rustc: tools.rustc.path, clang: tools.clang.path, 'clang-cl': tools.clang.path };
  for (const [name, file] of Object.entries(aliases)) {
    const alias = path.join(bin, name);
    try {
      if (!fs.lstatSync(alias).isSymbolicLink() || fs.readlinkSync(alias) !== file) throw new Error(`Candidate native tool alias differs from its frozen tool: ${alias}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.symlinkSync(file, alias);
    }
  }
  // Rust's gcc-ld wrapper both locates rust-lld relative to argv[0] and adds
  // -flavor link. cargo-xwin already supplies that flavor, so call its bound
  // runtime directly instead of relocating the wrapper or doubling the option.
  const linker = inside(root, path.join(bin, 'lld-link'));
  const launcher = `#!/bin/sh\nexec ${quote(tools.rustLld?.path || tools.lldLink.path)} "$@"\n`;
  if (fs.existsSync(linker) && fs.readFileSync(linker, 'utf8') !== launcher) throw new Error(`Candidate linker launcher differs from its frozen tool: ${linker}`);
  fs.writeFileSync(linker, launcher, { mode: 0o755 });
  verifyCachePaths(cache, tools.clang.path);
  verifyCachePaths(cargoHome, null);
  const env = nativeEnvironment({ bin, clang: tools.clang.path, cargoHome, cache, rustc: tools.rustc.path });
  for (const [name, tool] of Object.entries(tools)) {
    tool.version = await runTool(tool.path, name === 'rustLld' ? ['-flavor', 'link', '--version'] : ['--version'], { env, timeout: 30000, label: `Native tool ${name}`, log, includeStderr: true });
  }
  const receiptPath = inside(root, path.join(root, 'resource-monitor.json'));
  const previous = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
  if (previous && (previous.source.sha256 !== sourceIdentity.sha256 || JSON.stringify(previous.tools) !== JSON.stringify(tools))) {
    throw new Error('Windows resource monitor inputs differ from this candidate receipt. Start a fresh candidate.');
  }
  const sdk = inside(root, path.join(cache, 'xwin'));
  if (previous && treeIdentity(sdk, new Set(), true).sha256 !== previous.sdk.sha256) throw new Error('Candidate Microsoft SDK cache differs from the native build receipt. Start a fresh candidate.');
  // Always compile into a new empty target directory. REUSE is granted only after
  // this invocation produced and validated the exact candidate's new executable.
  const attempt = fs.mkdtempSync(path.join(root, 'build-'));
  const targetDir = path.join(attempt, 'target');
  const command = ['build', '--locked', '--release', '--manifest-path', path.join(source, 'Cargo.toml'), '--target', TARGET, '--target-dir', targetDir];
  log(`Building fresh Windows resource monitor from ${sourceIdentity.sha256}; Microsoft SDK cache ${cache}.`);
  let output;
  try {
    output = await runTool(tools.cargoXwin.path, command, { env, cwd: attempt, timeout: 1200000, label: 'Build Windows resource monitor with cargo-xwin', log, includeStderr: true });
  } catch (error) {
    const failedLog = path.join(attempt, 'build.log');
    fs.writeFileSync(failedLog, `${error.output || ''}\n${error.stderr || ''}\n${error.message}\n`);
    error.message += ` Native build log: ${failedLog}`;
    throw error;
  }
  fs.writeFileSync(path.join(attempt, 'build.log'), output + '\n');
  if (treeIdentity(source, new Set(['target'])).sha256 !== sourceIdentity.sha256) throw new Error('Resource monitor source changed during its Windows build.');
  for (const tool of Object.values(tools)) if (sha256(tool.path) !== tool.sha256) throw new Error(`Native tool changed during compilation: ${tool.path}`);
  const built = verifyWindowsPE(inside(root, path.join(targetDir, TARGET, 'release', EXECUTABLE)));
  const sdkIdentity = treeIdentity(sdk, new Set(), true);
  if (!sdkIdentity.files.some(file => file.path === 'DONE')) throw new Error('cargo-xwin did not finish provisioning its candidate Microsoft SDK cache.');
  inside(harnessRoot, artifact);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.copyFileSync(built.path, artifact);
  const copied = verifyWindowsPE(artifact);
  if (copied.sha256 !== built.sha256) throw new Error('Staged Windows resource monitor differs from the fresh compiler output.');
  const receipt = { schemaVersion: 1, target: TARGET, source: { root: source, ...sourceIdentity }, tools, sdk: { root: sdk, sha256: sdkIdentity.sha256, fileCount: sdkIdentity.files.length, manifest: fs.readFileSync(path.join(sdk, 'DONE'), 'utf8').trim().split('\n') }, command, artifact: copied, builtArtifact: built, nativeBoot: 'not-verified' };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  log(`Verified fresh Windows x64 resource monitor ${copied.sha256} (${copied.size} bytes).`);
  return { env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: 'true' }, receipt, receiptPath, artifact };
}

module.exports = { buildWindowsResourceMonitor, nativeEnvironment, verifyWindowsPE };
