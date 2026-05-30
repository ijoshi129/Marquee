const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./harness');

const dir = __dirname;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()) {
  require(path.join(dir, file));
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
