#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { fileHash } = require('./release-runner.cjs');
async function collect(copies) {
  for (const { source, destination } of copies) {
    const expected = await fileHash(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destination)) {
      if (await fileHash(destination) !== expected) throw new Error(`Handoff already contains different bytes: ${destination}`);
      continue;
    }
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      if (await fileHash(temporary) !== expected || await fileHash(source) !== expected) throw new Error(`Artifact changed during handoff: ${source}`);
      fs.linkSync(temporary, destination); // No overwrite, including a concurrent writer.
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
if (require.main === module) collect(JSON.parse(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { collect };
