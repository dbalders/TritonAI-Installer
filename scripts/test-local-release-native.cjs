'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildWindowsResourceMonitor, nativeEnvironment, verifyWindowsPE } = require('./local-release-native.cjs');

function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(0x20b, 152);
  return bytes;
}

function fixture(t, behavior = '') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tritonai-native-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'native'), harnessRoot = path.join(directory, 'harness source');
  const source = path.join(harnessRoot, 'native/resource-monitor');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs']) fs.writeFileSync(path.join(source, file), file);
  const toolDirectory = path.join(directory, "pinned tool's bin");
  fs.mkdirSync(path.join(toolDirectory, 'gcc-ld'), { recursive: true });
  const tools = {};
  for (const name of ['cargo', 'rustc', 'cargoXwin', 'clang', 'lldLink', 'rust-lld']) {
    const tool = path.join(toolDirectory, name === 'lldLink' ? 'gcc-ld/lld-link' : name);
    fs.writeFileSync(tool, `#!${process.execPath}\nconsole.log(${JSON.stringify(name + ' fixture 1.0')});`, { mode: 0o755 });
    if (name !== 'rust-lld') tools[name] = tool;
  }
  const calls = path.join(directory, 'calls.json');
  fs.writeFileSync(tools.cargoXwin, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('cargo-xwin 0.23.0');process.exit(0)}
const args=process.argv.slice(2),target=args[args.indexOf('--target-dir')+1];
if(fs.existsSync(target))throw Error('target was not fresh');
const calls=${JSON.stringify(calls)};
const previous=fs.existsSync(calls)?JSON.parse(fs.readFileSync(calls)):[];
previous.push({args,path:process.env.PATH,cache:process.env.XWIN_CACHE_DIR,cargoHome:process.env.CARGO_HOME,rustc:process.env.RUSTC});
fs.writeFileSync(calls,JSON.stringify(previous));
${behavior}
const output=path.join(target,'x86_64-pc-windows-msvc/release/t3-resource-monitor.exe');
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,Buffer.from(${JSON.stringify(pe().toString('base64'))},'base64'));
const sdk=path.join(process.env.XWIN_CACHE_DIR,'xwin');fs.mkdirSync(sdk,{recursive:true});
fs.writeFileSync(path.join(sdk,'DONE'),${JSON.stringify('x86_64\nfixture-sdk.msi\n')});
if(!fs.existsSync(path.join(sdk,'version')))fs.symlinkSync('.',path.join(sdk,'version'));
console.log('fixture fresh compile completed');
`, { mode: 0o755 });
  return { directory, root, harnessRoot, source, calls, tools, options: { root, harnessRoot, ...tools, log: () => {} } };
}

test('only a fresh verified x64 compile grants reuse and records source, SDK, tools, and output', async (t) => {
  if (process.platform === 'win32') return t.skip('macOS cross-build executable aliases');
  const f = fixture(t);
  const oldArtifact = path.join(f.source, 'target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe');
  fs.mkdirSync(path.dirname(oldArtifact), { recursive: true }); fs.writeFileSync(oldArtifact, 'old candidate');
  const first = await buildWindowsResourceMonitor(f.options);
  assert.deepEqual(first.env, { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: 'true' });
  assert.equal(first.receipt.nativeBoot, 'not-verified');
  assert.equal(first.receipt.artifact.sha256, first.receipt.builtArtifact.sha256);
  assert.equal(first.receipt.tools.rustLld.path, path.join(path.dirname(f.tools.clang), 'rust-lld'));
  assert.deepEqual(first.receipt.source.files.map(file => file.path), ['Cargo.lock', 'Cargo.toml', 'src/main.rs']);
  assert.deepEqual(first.receipt.sdk.manifest, ['x86_64', 'fixture-sdk.msi']);
  assert.equal(fs.readFileSync(first.artifact).toString('base64'), pe().toString('base64'));
  const linker = spawnSync(path.join(f.root, 'bin/lld-link'), ['-flavor', 'link', '--version'], { encoding: 'utf8' });
  assert.equal(linker.status, 0, linker.stderr); assert.match(linker.stdout, /rust-lld fixture/);
  const second = await buildWindowsResourceMonitor(f.options);
  assert.notEqual(first.receipt.builtArtifact.path, second.receipt.builtArtifact.path);
  const calls = JSON.parse(fs.readFileSync(f.calls));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--locked')); assert.ok(calls[0].args.includes('x86_64-pc-windows-msvc'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--manifest-path') + 1], path.join(f.source, 'Cargo.toml'));
  assert.equal(calls[0].path.split(path.delimiter)[0], path.join(f.root, 'bin'));
  assert.equal(calls[0].cache, path.join(f.root, 'cache')); assert.equal(calls[0].cargoHome, path.join(f.root, 'cargo-home'));
  fs.writeFileSync(path.join(f.root, 'cache/xwin/DONE'), 'modified');
  await assert.rejects(buildWindowsResourceMonitor(f.options), /SDK cache differs/);
  assert.equal(JSON.parse(fs.readFileSync(f.calls)).length, 2);
});

test('a compiler failure cannot accept a prior binary or emit a success receipt', async (t) => {
  if (process.platform === 'win32') return t.skip('macOS cross-build executable aliases');
  const f = fixture(t, "console.error('compiler failed');process.exit(1);");
  const stale = path.join(f.source, 'target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe');
  fs.mkdirSync(path.dirname(stale), { recursive: true }); fs.writeFileSync(stale, pe());
  await assert.rejects(buildWindowsResourceMonitor(f.options), /compiler failed/);
  assert.equal(fs.existsSync(path.join(f.root, 'resource-monitor.json')), false);
});

test('source changes during compilation reject the binary before staging', async (t) => {
  if (process.platform === 'win32') return t.skip('macOS cross-build executable aliases');
  const f = fixture(t, "const manifest=args[args.indexOf('--manifest-path')+1];fs.appendFileSync(manifest,' changed');");
  await assert.rejects(buildWindowsResourceMonitor(f.options), /source changed during/);
  assert.equal(fs.existsSync(path.join(f.root, 'resource-monitor.json')), false);
  assert.equal(fs.existsSync(path.join(f.source, 'target')), false);
});

test('native cache whitespace and escaping cache symlinks fail before compilation', async (t) => {
  if (process.platform === 'win32') return t.skip('macOS cross-build symlink isolation');
  const f = fixture(t);
  await assert.rejects(buildWindowsResourceMonitor({ ...f.options, root: path.join(f.directory, 'native cache') }), /cache path cannot contain whitespace/);
  assert.equal(fs.existsSync(path.join(f.directory, 'native cache')), false);
  fs.mkdirSync(path.join(f.root, 'cache'), { recursive: true });
  fs.symlinkSync(f.source, path.join(f.root, 'cache/xwin'));
  await assert.rejects(buildWindowsResourceMonitor(f.options), /symlink in candidate native cache/);
  assert.equal(fs.existsSync(f.calls), false);
});

test('staging through a symlink cannot overwrite an external artifact', async (t) => {
  if (process.platform === 'win32') return t.skip('macOS cross-build symlink isolation');
  const f = fixture(t);
  const elsewhere = path.join(f.directory, 'other-candidate'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(f.source, 'target'));
  await assert.rejects(buildWindowsResourceMonitor(f.options), /must not contain symlinks/);
  assert.equal(fs.existsSync(f.calls), false);
});

test('rejects wrong-platform and truncated compiler output', (t) => {
  const f = fixture(t), artifact = path.join(f.directory, 'wrong.exe');
  for (const bytes of [Buffer.from('MZ'), pe(0xaa64), pe(0x14c), Buffer.from('not an executable')]) {
    fs.writeFileSync(artifact, bytes);
    assert.throws(() => verifyWindowsPE(artifact), /not a Windows x64 PE32\+/);
  }
});

test('native environment ignores ambient cross-build flags without mutating global state', () => {
  const baseEnv = { PATH: '/shared', CARGO: '/unfrozen/cargo', CARGO_HOME: '/shared/cargo', CARGO_ENCODED_RUSTFLAGS: 'bad', RUSTC_WRAPPER: 'bad', RUSTFLAGS: 'bad', XWIN_CACHE_DIR: '/shared/sdk', XWIN_SDK_VERSION: 'bad', CC: 'bad', LIB: 'bad', HTTPS_PROXY: 'proxy' };
  const before = { ...baseEnv };
  const env = nativeEnvironment({ bin: '/candidate/bin', clang: '/xcode/clang', cargoHome: '/candidate/cargo', cache: '/candidate/sdk', rustc: '/pinned/rustc', baseEnv });
  assert.deepEqual(baseEnv, before);
  for (const key of ['CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTFLAGS', 'XWIN_SDK_VERSION', 'CC', 'LIB']) assert.equal(env[key], undefined);
  assert.equal(env.HTTPS_PROXY, 'proxy'); assert.equal(env.XWIN_ARCH, 'x86_64');
  assert.equal(env.CARGO_HOME, '/candidate/cargo'); assert.equal(env.RUSTC, '/pinned/rustc');
  assert.equal(env.CARGO, path.join('/candidate/bin', 'cargo'));
  assert.ok(env.PATH.indexOf('/candidate/bin') < env.PATH.indexOf('/opt/homebrew/opt/llvm/bin'));
});
