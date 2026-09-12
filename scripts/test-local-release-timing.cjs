const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('retains successful and failed operation timings without recording error details', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-timing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'timings.jsonl');
  const output = execFileSync(process.execPath, ['-e', `
    const { measure, measureSync } = require('./scripts/local-release-timing.cjs');
    (async () => {
      const value = measureSync('prepare', () => 42);
      if (value !== 42) throw new Error('lost result');
      try { await measure('package', async () => { throw new Error('private-detail'); }); }
      catch (error) { if (error.message !== 'private-detail') throw error; }
    })();
  `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env,
    TRITONAI_RELEASE_TIMING_FILE: file, TRITONAI_RELEASE_TIMING_STAGE: 'installer-mac' }, encoding: 'utf8' });
  const data = fs.readFileSync(file, 'utf8');
  const records = data.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r => [r.label, r.status]), [['prepare', 'complete'], ['package', 'failed']]);
  for (const record of records) {
    assert.equal(record.stage, 'installer-mac');
    assert.ok(record.durationMs >= 0);
    assert.ok(Date.parse(record.completedAt) >= Date.parse(record.startedAt));
  }
  assert.ok(!data.includes('private-detail'));
  assert.ok(!output.includes('private-detail'));
});
