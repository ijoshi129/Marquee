const tests = [];
const afterEachFns = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function afterEach(fn) {
  afterEachFns.push(fn);
}

async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`not ok - ${t.name}`);
      console.error(err && err.stack ? err.stack : err);
    } finally {
      for (const fn of afterEachFns) {
        await fn();
      }
    }
  }

  const passed = tests.length - failed;
  console.log(`\n${passed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
}

module.exports = { test, afterEach, run };
