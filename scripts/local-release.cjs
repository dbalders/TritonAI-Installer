#!/usr/bin/env node
// One local release entry point. Recipes execute through the existing checksummed runner.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { run, treeHash } = require('./release-runner.cjs');

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failureExitCode = error => error.exitCode === 130 || error.exitCode === 143 ? error.exitCode : 1;
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function parseArgs(args) {
  const options = {};
  const values = new Set(['profile', 'output', 'plugins', 'skills', 'harness', 'installer', 'jobs']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '--check', '--plan', '--status', '--fresh'].includes(arg)) options[arg.slice(2)] = true;
    else if (arg.startsWith('--') && values.has(arg.slice(2))) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      if (options[arg.slice(2)] !== undefined) throw new Error(`Repeated ${arg}`);
      options[arg.slice(2)] = args[++i];
    } else if (!options.version && VERSION.test(arg)) options.version = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !VERSION.test(options.version || '')) throw new Error('Supply the release version, e.g. npm run release:local -- 0.3.4');
  if (options.jobs !== undefined && !['1', '2'].includes(options.jobs)) throw new Error('--jobs must be 1 or 2');
  return options;
}

function executable(name, directories = []) {
  if (path.isAbsolute(name)) {
    try { fs.accessSync(name, fs.constants.X_OK); return fs.statSync(name).isFile() ? name : null; } catch { return null; }
  }
  for (const dir of [...directories, ...(process.env.PATH || '').split(path.delimiter)]) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

// Branch names always resolve against the fetched remote, never a stale local main.
function resolveRef(repo, selection, fetch = true) {
  if (typeof selection !== 'string' || !selection || selection.startsWith('-') || /[\s~^:\\]/.test(selection) || selection.includes('..') || selection.includes('@{')) throw new Error(`Invalid source selector: ${selection}`);
  if (fetch) git(repo, 'fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--tags', '--prune');
  const commitAt = ref => {
    // Keep local tags intact, but named remote selections must still exist upstream.
    if (fetch && ref.startsWith('refs/tags/') && !git(repo, 'ls-remote', '--refs', 'origin', ref)) throw new Error(`Unknown remote tag: ${ref}`);
    return git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
  };
  if (SHA.test(selection)) {
    // Explicit immutable local commits support validating a release-tooling fix
    // before it is merged. Moving branch selectors still come only from origin.
    try { git(repo, 'cat-file', '-e', `${selection}^{commit}`); }
    catch { if (fetch) git(repo, 'fetch', 'origin', selection); }
    return { selection, commit: git(repo, 'rev-parse', '--verify', `${selection}^{commit}`) };
  }
  const ref = selection.startsWith('refs/tags/') ? selection
    : selection.startsWith('refs/heads/') ? `refs/remotes/origin/${selection.slice(11)}` : null;
  if (ref) return { selection, commit: commitAt(ref) };
  if (selection.startsWith('refs/')) throw new Error(`Use a branch, tag, or full commit: ${selection}`);
  const matches = [];
  for (const candidate of [`refs/tags/${selection}`, `refs/remotes/origin/${selection}`]) {
    try { matches.push(commitAt(candidate)); } catch {}
  }
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous branch/tag '${selection}'; use refs/heads/ or refs/tags/.` : `Unknown remote branch/tag: ${selection}`);
  return { selection, commit: matches[0] };
}

function profileFor(options) {
  const profileFile = path.resolve(options.profile || process.env.TRITONAI_RELEASE_PROFILE || path.join(os.homedir(), '.config/tritonai/release.json'));
  const profile = fs.existsSync(profileFile) ? read(profileFile) : {};
  if (profile.schemaVersion !== undefined && profile.schemaVersion !== 1) throw new Error('Unsupported release profile schemaVersion');
  const installerRoot = git(path.resolve(__dirname, '..'), 'worktree', 'list', '--porcelain').split('\n').find(line => line.startsWith('worktree ')).slice(9);
  const umbrella = path.dirname(installerRoot);
  const repos = { harness: path.join(umbrella, 'TritonAI-Harness'), installer: installerRoot, plugins: path.join(umbrella, 'TritonAI-Plugins'), skills: path.join(path.dirname(umbrella), 'UCSD-Skills-Library-Secure'), ...profile.repositories };
  for (const key of Object.keys(repos)) repos[key] = path.resolve(repos[key]);
  const nodeDirs = path.join(os.homedir(), '.nvm/versions/node');
  const available = fs.existsSync(nodeDirs) ? fs.readdirSync(nodeDirs).filter(v => /^v24\./.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(v => path.join(nodeDirs, v, 'bin')) : [];
  const node = executable(profile.node || 'node', available);
  const vp = executable(profile.vp || 'vp', [path.join(os.homedir(), '.vite-plus/bin')]);
  return { profileFile, profile, repos, tools: { node, vp, wine: executable(profile.wine || 'wine64', ['/usr/local/bin', '/opt/homebrew/bin']) } };
}

function cleanEnvironment(base = process.env, tools = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(TRITONAI_|T3CODE_|UCSD_|CSC_|WIN_CSC_|APPLE_|AZURE_|ELECTRON_BUILDER_)/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'WINEPREFIX', 'WINE', 'GITHUB_OUTPUT', 'VITE_HTTP_URL', 'VITE_WS_URL', 'DEVELOPER_ID_APPLICATION'].includes(key.toUpperCase())) delete env[key];
  // Tools and release credentials are loaded explicitly from the saved profile below.
  env.PATH = [...new Set([tools.node && path.dirname(tools.node), tools.vp && path.dirname(tools.vp), ...(env.PATH || '').split(path.delimiter)].filter(Boolean))].join(path.delimiter);
  return env;
}

function inspectHostCommands(tools, { platform = process.platform, find = executable, execute = execFileSync } = {}) {
  const problems = [], found = {};
  const directories = [tools.node && path.dirname(tools.node), tools.vp && path.dirname(tools.vp)].filter(Boolean);
  const required = ['git', 'npm', 'corepack', ...(platform === 'darwin' ? [
    'security', 'codesign', 'hdiutil', 'xcrun', 'spctl', 'curl', 'tar', 'unzip', 'plutil', 'make', 'python3',
    '/usr/bin/ditto', '/usr/sbin/lsof', '/bin/ps',
  ] : [])];
  for (const name of required) {
    found[name] = find(name, directories);
    if (!found[name]) problems.push(`Missing required release command: ${name}.`);
  }
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env: cleanEnvironment(process.env, tools) };
  for (const name of ['npm', 'corepack']) if (found[name]) {
    try { execute(found[name], ['--version'], options); }
    catch { problems.push(`${name} is installed but cannot run with the selected Node toolchain.`); }
  }
  if (found.xcrun) for (const name of ['clang', 'notarytool', 'stapler']) {
    try { execute(found.xcrun, ['--find', name], options); }
    catch { problems.push(`The selected Xcode toolchain cannot locate ${name}; configure xcode-select before building.`); }
  }
  return problems;
}

async function preflight(settings, { disk = true, directory } = {}) {
  const { profile, tools, repos } = settings;
  const problems = [];
  if (process.platform !== 'darwin') problems.push('The Mac/Windows local recipe runs on the configured Mac release host.');
  for (const [name, file] of Object.entries(tools)) if (!file) problems.push(`Missing ${name}; set '${name}' in ${settings.profileFile}.`);
  problems.push(...inspectHostCommands(tools));
  if (tools.node) {
    const version = execFileSync(tools.node, ['--version'], { encoding: 'utf8' }).trim();
    if (!/^v24\./.test(version)) problems.push(`Node 24 is required; selected ${version}. Set profile.node.`);
  }
  for (const [name, repo] of Object.entries(repos)) {
    try { if (git(repo, 'rev-parse', '--show-toplevel') !== fs.realpathSync(repo)) throw new Error(); }
    catch { problems.push(`Missing ${name} repository: ${repo}`); }
  }
  let configuration;
  try {
    if (!profile.pluginConfigurationFile || !path.isAbsolute(profile.pluginConfigurationFile)) throw new Error();
    configuration = read(profile.pluginConfigurationFile);
    if (!configuration || Array.isArray(configuration) || typeof configuration !== 'object') throw new Error();
  } catch { problems.push(`Set pluginConfigurationFile to an existing JSON object file in ${settings.profileFile}.`); }
  let identity = profile.developerId;
  if (process.platform === 'darwin' && executable('security')) {
    let output = '';
    try { output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); }
    catch { problems.push('Unable to read code-signing identities from the keychain.'); }
    const identities = [...output.matchAll(/"Developer ID Application: ([^"]+)"/g)].map(m => m[1]);
    if (identity) {
      identity = identity.replace(/^Developer ID Application:\s*/, '');
      if (!identities.includes(identity)) problems.push('The selected developerId signing identity is not available in the keychain.');
    } else if (identities.length === 1) identity = identities[0];
    else problems.push('Select developerId in the release profile; exactly one signing identity was not found.');
  }
  const notaryFile = profile.notarizationConfig || path.join(os.homedir(), '.agents/secrets/appstore/config.json');
  let notary;
  try {
    const c = read(notaryFile);
    const key = path.resolve(path.dirname(notaryFile), c.keyFile);
    if (!c.keyId || !c.issuerId || !fs.statSync(key).isFile()) throw new Error();
    notary = { configFile: notaryFile, keyFile: key, keyId: c.keyId, issuerId: c.issuerId };
  } catch { problems.push(`Missing/invalid notarization configuration: ${notaryFile}`); }
  if (disk) {
    const diskPath = directory || profile.outputRoot || path.join(os.homedir(), 'Documents');
    let ancestor = path.resolve(diskPath);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const space = fs.statfsSync(ancestor);
    const free = space.bavail * space.bsize / 1024 ** 3;
    const minimum = profile.minimumFreeGiB ?? 35;
    if (!Number.isFinite(minimum) || minimum < 10) problems.push('minimumFreeGiB must be at least 10. Default: 35 for two platforms.');
    else if (free < minimum) problems.push(`${free.toFixed(1)} GiB free; ${minimum} GiB required at ${ancestor}. Choose a larger outputRoot or reclaim inactive build staging.`);
  }
  return { problems, configuration, identity, notary };
}

async function freezeTools(tools) {
  const paths = {}, identities = {};
  for (const [name, file] of Object.entries(tools)) {
    paths[name] = fs.realpathSync(file);
    identities[name] = { path: paths[name], sha256: await treeHash(paths[name]) };
  }
  return { tools: paths, toolIdentities: identities };
}

async function assertToolIdentities(candidate) {
  if (!candidate.toolIdentities) throw new Error('Candidate predates executable pinning; use --fresh.');
  for (const [name, identity] of Object.entries(candidate.toolIdentities)) {
    if (candidate.tools[name] !== identity.path || await treeHash(identity.path) !== identity.sha256) throw new Error(`${name} executable changed; use --fresh.`);
  }
}

async function freeze(options, settings, ready) {
  const sources = {};
  for (const name of ['harness', 'installer', 'skills']) sources[name] = { repo: settings.repos[name], ...resolveRef(settings.repos[name], options[name] || 'main') };
  const installerPackage = JSON.parse(git(sources.installer.repo, 'show', `${sources.installer.commit}:package.json`));
  if (!installerPackage.scripts?.['release:local']) throw new Error('Selected Installer commit predates the local release workflow. Merge the workflow changes, or select their exact local commit with --installer.');
  const catalog = JSON.parse(git(sources.installer.repo, 'show', `${sources.installer.commit}:config/managed-plugin-catalog.json`));
  sources.plugins = { repo: settings.repos.plugins, ...resolveRef(settings.repos.plugins, options.plugins || catalog.source.commit) };
  const pluginIds = catalog.packages.map(p => p.pluginId);
  for (const id of pluginIds) if (!ready.configuration[id] || Array.isArray(ready.configuration[id]) || typeof ready.configuration[id] !== 'object') throw new Error(`Plugin configuration is missing '${id}' in ${settings.profile.pluginConfigurationFile}`);
  const configuration = Object.fromEntries(pluginIds.map(id => [id, ready.configuration[id]]));
  return { schemaVersion: 1, version: options.version, sources, pluginIds, catalogSelection: !options.plugins,
    ...await freezeTools(settings.tools), profileFile: settings.profileFile, configurationFile: settings.profile.pluginConfigurationFile,
    configurationSha256: hash(JSON.stringify(configuration)), developerId: ready.identity,
    notary: { ...ready.notary, keySha256: await treeHash(ready.notary.keyFile) },
    selectedAt: new Date().toISOString(), published: false };
}

function candidateEnvironment(candidate) {
  const config = read(candidate.configurationFile);
  const serialized = JSON.stringify(Object.fromEntries(candidate.pluginIds.map(id => [id, config[id]])));
  if (hash(serialized) !== candidate.configurationSha256) throw new Error('Plugin configuration changed. Use --fresh for a new candidate.');
  return { ...cleanEnvironment(process.env, candidate.tools),
    TRITONAI_PLUGIN_CONFIGURATION_JSON: serialized, T3CODE_DESKTOP_UPDATE_REPOSITORY: 'dbalders/TritonAI-Harness' };
}

function macSigningEnvironment(candidate) {
  return { DEVELOPER_ID_APPLICATION: candidate.developerId,
    APPLE_API_KEY: candidate.notary.keyFile, APPLE_API_KEY_ID: candidate.notary.keyId, APPLE_API_ISSUER: candidate.notary.issuerId };
}

function assertResumeSelections(candidate, options) {
  if (candidate.version !== options.version) throw new Error('Candidate version differs; use another --output.');
  for (const name of ['harness', 'installer', 'plugins', 'skills']) if (options[name] && options[name] !== candidate.sources[name].selection) throw new Error(`${name} selection differs from this frozen candidate. Use --fresh.`);
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: npm run release:local -- VERSION [--plugins TAG|BRANCH|SHA] [--skills TAG|BRANCH|SHA]\n  --harness REF / --installer REF   Default: latest remote main\n  --profile FILE                   Default: ~/.config/tritonai/release.json\n  --check / --plan / --status       Inspect without building\n  --output DIR / --fresh            New candidate location; otherwise resume same version\n  --jobs 1|2                       Default: parallel Mac and Windows\nNo tags, uploads, releases, or publication. Plugin default: Installer catalog; skills default: main.');
    return;
  }
  const settings = profileFor(options);
  const directory = path.resolve(options.output || path.join(settings.profile.outputRoot || path.join(os.homedir(), 'Documents/TritonAI-builds'), `local-${options.version}${options.fresh ? '-' + new Date().toISOString().replace(/[:.]/g, '-') : ''}`));
  const candidateFile = path.join(directory, 'candidate.json');
  if (options.status) {
    if (!fs.existsSync(candidateFile)) throw new Error(`No candidate at ${directory}`);
    const c = read(candidateFile); console.log(JSON.stringify({ version: c.version, sources: c.sources, directory,
      preparation: fs.existsSync(path.join(directory, 'prepare.run/state.json')) ? read(path.join(directory, 'prepare.run/state.json')).steps : {},
      stages: fs.existsSync(path.join(directory, 'build.run/state.json')) ? read(path.join(directory, 'build.run/state.json')).steps : {} }, null, 2)); return;
  }
  let candidate;
  if (fs.existsSync(candidateFile)) {
    candidate = read(candidateFile); assertResumeSelections(candidate, options);
    await assertToolIdentities(candidate);
    if (await treeHash(candidate.notary.keyFile) !== candidate.notary.keySha256) throw new Error('Signing inputs changed; use --fresh.');
    const ready = await preflight({ ...settings, tools: candidate.tools, repos: Object.fromEntries(Object.entries(candidate.sources).map(([name, source]) => [name, source.repo])), profile: { ...settings.profile, pluginConfigurationFile: candidate.configurationFile, developerId: candidate.developerId, notarizationConfig: candidate.notary.configFile } }, { directory });
    if (ready.problems.length) throw new Error('Release preflight:\n- ' + ready.problems.join('\n- '));
  } else {
    const ready = await preflight(settings, { directory });
    if (ready.problems.length) throw new Error('Release preflight:\n- ' + ready.problems.join('\n- '));
    candidate = await freeze(options, settings, ready);
  }
  const env = candidateEnvironment(candidate);
  if (options.check || options.plan) { console.log(JSON.stringify({ version: candidate.version, directory, sources: candidate.sources, pluginIds: candidate.pluginIds, stages: ['prepare', 'validate-inputs', 'source-checks', 'harness-mac + harness-win', 'installer-mac + installer-win', 'handoff'], published: false }, null, 2)); return; }
  if (!fs.existsSync(candidateFile)) {
    if (fs.existsSync(directory)) throw new Error(`Unrecognized existing directory: ${directory}; select another --output.`);
    save(candidateFile, candidate);
  }
  // Runner children receive the explicit environment; global process.env stays untouched.
  const { executeWithEnvironment, makeBuildRecipe } = require('./local-release-stages.cjs');
  const command = [candidate.tools.node, path.join(__dirname, 'local-release-stages.cjs')];
  const scripts = fs.readdirSync(__dirname).filter(name => /^local-release.*\.cjs$/.test(name)).map(name => path.join(__dirname, name));
  const prepare = { schemaVersion: 1, steps: [{ id: 'prepare', cwd: directory, git: false,
    commands: [[...command, 'prepare', candidateFile]], inputs: [candidateFile, ...scripts, ...Object.values(candidate.toolIdentities)], outputs: ['prepared.json'] }] };
  await run(prepare, path.join(directory, 'prepare.run'), { jobs: 1, environment: env, executeCommand: executeWithEnvironment(env) });
  const recipe = makeBuildRecipe(candidateFile, read(path.join(directory, 'prepared.json')));
  const recipeFile = path.join(directory, 'release.json');
  if (!fs.existsSync(recipeFile)) save(recipeFile, recipe);
  else if (JSON.stringify(read(recipeFile)) !== JSON.stringify(recipe)) throw new Error('Recipe changed; use --fresh.');
  await run(recipe, path.join(directory, 'build.run'), { jobs: Number(options.jobs || 2), environment: env, executeCommand: executeWithEnvironment(env) });
  console.log(`Local candidate: ${path.join(directory, 'handoff')}\nReport: ${path.join(directory, 'handoff/report.json')}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = failureExitCode(error); });
module.exports = { parseArgs, executable, resolveRef, profileFor, cleanEnvironment, inspectHostCommands, preflight, freeze, freezeTools, assertToolIdentities, candidateEnvironment, macSigningEnvironment, assertResumeSelections, save, read, git, hash, failureExitCode, main };
