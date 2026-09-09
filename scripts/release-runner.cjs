#!/usr/bin/env node
// Run trusted, local release recipes. Commands are argv arrays, never shell strings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function save(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
async function fileHash(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function treeHash(entry) {
  const stat = fs.lstatSync(entry);
  if (stat.isSymbolicLink()) throw new Error(`Release input must not be a symlink: ${entry}`);
  if (stat.isFile()) return fileHash(entry);
  if (!stat.isDirectory()) throw new Error(`Unsupported input: ${entry}`);
  return digest(JSON.stringify(await Promise.all(fs.readdirSync(entry).sort().filter(name => name !== '.git')
    .map(async name => [name, await treeHash(path.join(entry, name))]))));
}
function sourceCommit(cwd) {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error(`Release source must be clean: ${cwd}`);
  return git('rev-parse', 'HEAD');
}
function validate(plan) {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.steps) || !plan.steps.length) throw new Error('Invalid release recipe');
  const ids = new Set();
  for (const step of plan.steps) {
    if (!/^[a-z0-9-]+$/.test(step.id) || ids.has(step.id)) throw new Error(`Invalid/duplicate step: ${step.id}`);
    ids.add(step.id);
    if (!path.isAbsolute(step.cwd) || !fs.statSync(step.cwd).isDirectory()) throw new Error(`Invalid cwd: ${step.id}`);
    if (!Array.isArray(step.commands) || !step.commands.length || step.commands.some(c => !Array.isArray(c) || !c.length || c.some(a => typeof a !== 'string'))) throw new Error(`Invalid commands: ${step.id}`);
    if (!Array.isArray(step.outputs) || step.outputs.some(p => typeof p !== 'string')) throw new Error(`Declare outputs for ${step.id}`);
    for (const key of step.requiredEnv || []) if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
  }
  const seen = new Set(), visiting = new Set();
  function visit(id) {
    if (!ids.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
    if (seen.has(id)) return;
    visiting.add(id);
    for (const dep of plan.steps.find(s => s.id === id).needs || []) visit(dep);
    visiting.delete(id); seen.add(id);
  }
  for (const id of ids) visit(id);
}
async function snapshot(step) {
  const keys = new Set([...(step.requiredEnv || []), ...Object.keys(process.env).filter(key => /^(TRITONAI_|UCSD_|T3CODE_|CSC_|WIN_CSC_|APPLE_|AZURE_|ELECTRON_BUILDER_)/.test(key))]);
  const environment = Object.fromEntries([...keys].sort().map(key => [key, process.env[key]]));
  const inputs = {};
  for (const input of step.inputs || []) inputs[input] = await treeHash(path.resolve(step.cwd, input));
  const sources = {};
  for (const entry of step.sources || []) {
    const source = typeof entry === 'string' ? entry : entry.path;
    sources[source] = sourceCommit(source);
    if (typeof entry !== 'string' && sources[source] !== entry.commit) throw new Error(`Source changed from prepared commit: ${source}`);
  }
  const source = step.git === false ? null : sourceCommit(step.cwd);
  if (step.commit && source !== step.commit) throw new Error(`Source changed from prepared commit: ${step.cwd}`);
  return digest(JSON.stringify({ step, source, sources, inputs, environment }));
}
async function outputs(step) {
  const result = {};
  for (const output of step.outputs) result[output] = await fileHash(path.resolve(step.cwd, output));
  return result;
}
async function execute(command, step, log) {
  // npm.cmd needs cmd.exe on Windows; invoking npm's JS entrypoint avoids shell quoting.
  let [executable, ...args] = command;
  if (process.platform === 'win32' && executable === 'npm' && process.env.npm_execpath) {
    executable = process.execPath; args = [process.env.npm_execpath, ...args];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: step.cwd, env: { ...process.env, ...step.env }, stdio: ['ignore', log, log], shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${step.id}: command exited ${code ?? signal}`)));
  });
}
function overlap(a, b) {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function run(plan, stateDir, { jobs = 2, dryRun = false, executeCommand = execute } = {}) {
  validate(plan);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('jobs must be between 1 and 8');
  if (dryRun) return { steps: plan.steps.map(({ id, needs, cwd, commands }) => ({ id, needs, cwd, commands })) };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, 'runner.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error(`Release runner is locked: ${lock}. If interrupted, confirm its process has stopped before removing the lock.`); }
  fs.writeSync(lockFd, String(process.pid));
  const stateFile = path.join(stateDir, 'state.json');
  const recipeHash = digest(JSON.stringify(plan) + fs.readFileSync(__filename, 'utf8'));
  let state;
  const active = new Map(), done = new Set();
  let failure;
  try {
    state = fs.existsSync(stateFile) ? json(stateFile) : { schemaVersion: 1, recipeHash, steps: {} };
    if (state.recipeHash !== recipeHash) throw new Error('Recipe changed. Use a new state directory for a new candidate.');
    // Check every completed receipt before starting any new work.
    for (const step of plan.steps) {
      const receipt = state.steps[step.id];
      if (receipt?.inputHash && receipt.inputHash !== await snapshot(step)) throw new Error(`Completed stage changed or attempted inputs changed: ${step.id}. Use a fresh candidate.`);
      if (receipt?.status !== 'complete') continue;
      if (JSON.stringify(receipt.outputs) !== JSON.stringify(await outputs(step))) throw new Error(`Completed stage changed: ${step.id}. Use a fresh candidate; refusing to rebuild verified artifacts.`);
      done.add(step.id);
      console.log(`[${step.id}] reused verified outputs`);
    }
    async function launch(step) {
      const inputHash = await snapshot(step);
      if (state.steps[step.id]?.inputHash && state.steps[step.id].inputHash !== inputHash) throw new Error(`Inputs changed since the previous attempt: ${step.id}`);
      const logPath = path.join(stateDir, `${step.id}.log`);
      const log = fs.openSync(logPath, 'a', 0o600);
      state.steps[step.id] = { status: 'running', inputHash, startedAt: new Date().toISOString(), logPath };
      save(stateFile, state);
      console.log(`[${step.id}] started; ${logPath}`);
      try {
        for (const command of step.commands) await executeCommand(command, step, log);
        if (await snapshot(step) !== inputHash) throw new Error(`Inputs changed during ${step.id}`);
        state.steps[step.id] = { ...state.steps[step.id], status: 'complete', outputs: await outputs(step), completedAt: new Date().toISOString() };
        done.add(step.id);
        console.log(`[${step.id}] complete`);
      } catch (error) {
        state.steps[step.id] = { ...state.steps[step.id], status: 'failed', error: error.message };
        throw error;
      } finally { fs.closeSync(log); save(stateFile, state); }
    }
    while (done.size < plan.steps.length) {
      for (const step of plan.steps) {
        if (failure || active.size >= jobs) break;
        if (done.has(step.id) || active.has(step.id) || (step.needs || []).some(id => !done.has(id))) continue;
        if ([...active.keys()].some(id => {
          const other = plan.steps.find(s => s.id === id);
          return overlap(step.cwd, other.cwd) || overlap(other.cwd, step.cwd) || (step.resources || []).some(r => (other.resources || []).includes(r));
        })) continue;
        const promise = launch(step).catch(error => { failure ||= error; }).finally(() => active.delete(step.id));
        active.set(step.id, promise);
      }
      if (!active.size) { if (failure) throw failure; throw new Error('No runnable release steps'); }
      await Promise.race(active.values());
      if (failure) { await Promise.all(active.values()); throw failure; }
    }
    return { status: 'complete', stateFile, steps: state.steps };
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('Usage: node scripts/release-runner.cjs <recipe.json> [--dry-run] [--jobs N]\nResumes matching completed steps. Logs and receipts live beside the recipe in <recipe>.run/.');
    return;
  }
  const [file, ...flags] = args;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--dry-run') continue;
    if (flags[i] === '--jobs' && flags[i + 1]) { i++; continue; }
    throw new Error(`Unknown argument: ${flags[i]}`);
  }
  const absolute = path.resolve(file);
  const result = await run(json(absolute), `${absolute}.run`, { dryRun: flags.includes('--dry-run'), jobs: flags.includes('--jobs') ? Number(flags[flags.indexOf('--jobs') + 1]) : 2 });
  console.log(JSON.stringify(flags.includes('--dry-run') ? result : { status: result.status, stateFile: result.stateFile, steps: Object.fromEntries(Object.entries(result.steps).map(([id, step]) => [id, step.status])) }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, validate, fileHash, treeHash };
