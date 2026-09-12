'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Labels describe work, never command arguments, environment, or error messages.
// Append one record per operation so failed attempts survive a resumed build.
function start(label) {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const file = process.env.TRITONAI_RELEASE_TIMING_FILE;
  const stage = process.env.TRITONAI_RELEASE_TIMING_STAGE || 'release';
  console.log(`[timing] ${startedAt} ${stage}: ${label} started`);
  return (status) => {
    const record = { stage, label, status, startedAt, completedAt: new Date().toISOString(),
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6), pid: process.pid };
    console.log(`[timing] ${record.completedAt} ${stage}: ${label} ${status} (${(record.durationMs / 1000).toFixed(2)}s)`);
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    }
  };
}

function measureSync(label, action) {
  const finish = start(label);
  let status = 'failed';
  try { const result = action(); status = 'complete'; return result; }
  finally { finish(status); }
}

async function measure(label, action) {
  const finish = start(label);
  let status = 'failed';
  try { const result = await action(); status = 'complete'; return result; }
  finally { finish(status); }
}

module.exports = { measure, measureSync };
