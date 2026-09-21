import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Test double for `evaluator-worker.js`.
 *
 * Behaviour is chosen by `input.probeMode` so the isolation wrapper can be
 * driven into paths the real worker never reaches: a malformed result, an
 * output flood, an environment probe, and a grandchild that must be killed with
 * the group.
 */
const lines = createInterface({ input: process.stdin });
lines.once('line', (line) => {
  const { input } = JSON.parse(line);
  const mode = input?.probeMode ?? 'ok';

  if (mode === 'bad-schema') {
    process.stdout.write(JSON.stringify({ result: { quality: 'not-a-number', cost: 0, parallelEfficiency: 0, missRate: 0, score: 0 } }) + '\n');
    return;
  }

  if (mode === 'env-probe') {
    const leaked = process.env.DREAM_RSI_TEST_SECRET;
    process.stdout.write(JSON.stringify({ result: { quality: leaked === undefined ? 1 : 999, cost: 0, parallelEfficiency: 0, missRate: 0, score: 1 } }) + '\n');
    return;
  }

  // The next two probes encode their answer in `quality`, the same way
  // env-probe does: 1 means the operation was denied.
  if (mode === 'write-probe') {
    // `require` is not defined in an ESM module, so the probe has to use the
    // import: a ReferenceError would otherwise read as "not denied".
    let denied = 0;
    try {
      writeFileSync(input.target, 'confined write');
    } catch (error) {
      denied = error.code === 'ERR_ACCESS_DENIED' ? 1 : 0;
    }
    process.stdout.write(JSON.stringify({ result: { quality: denied, cost: 0, parallelEfficiency: 0, missRate: 0, score: 0 } }) + '\n');
    return;
  }

  if (mode === 'spawn-probe') {
    let denied = 0;
    try {
      // spawnSync reports a denial both by throwing and by returning an error,
      // depending on where the check lands.
      const outcome = spawnSync(process.execPath, ['-e', '0']);
      denied = outcome.error?.code === 'ERR_ACCESS_DENIED' ? 1 : 0;
    } catch (error) {
      denied = error.code === 'ERR_ACCESS_DENIED' ? 1 : 0;
    }
    process.stdout.write(JSON.stringify({ result: { quality: denied, cost: 0, parallelEfficiency: 0, missRate: 0, score: 0 } }) + '\n');
    return;
  }

  if (mode === 'noisy') {
    // Far more than any caller should accept.
    process.stdout.write('x'.repeat(4 * 1024 * 1024));
    return;
  }

  if (mode === 'spawn-child') {
    // The grandchild inherits this process group, so killing the group must
    // take it down too. It lives far longer than the parent's deadline.
    const script = `require('fs').writeFileSync(${JSON.stringify(input.pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
    spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    return;
  }

  if (mode === 'crash') {
    // A worker that dies without producing a verdict.
    process.stderr.write('worker crashed\n');
    process.exit(3);
  }

  if (mode === 'hang') {
    // Keep the event loop alive: returning here would let the process exit with
    // no output, which tests the parser rather than the deadline.
    setInterval(() => {}, 1_000);
    return;
  }

  process.stdout.write(JSON.stringify({ result: { quality: 1, cost: 0, parallelEfficiency: 0, missRate: 0, score: 1 } }) + '\n');
});
