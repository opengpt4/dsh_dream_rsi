import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateReplayIsolated } from '../dist/evolution/isolated-evaluator.js';

test('isolated evaluator returns the same deterministic result as the core evaluator', async () => {
  const result = await evaluateReplayIsolated({
    visitedNodes: [],
    boundaryMissCount: 0,
    totalAttempts: 0,
    criticalPathMs: 1
  });

  assert.deepEqual(result, {
    quality: 0,
    cost: 0,
    parallelEfficiency: 0,
    missRate: 0,
    score: 0
  });
});

test('isolated evaluator rejects invalid timeout configuration', async () => {
  await assert.rejects(
    evaluateReplayIsolated({ visitedNodes: [], boundaryMissCount: 0, totalAttempts: 0, criticalPathMs: 1 }, undefined, { timeoutMs: 0 }),
    /timeoutMs must be positive/
  );
});

// ------------------------------------------- the untrusted half of the boundary

/**
 * Run the evaluator against a worker that answers with `response` verbatim.
 *
 * The child is the untrusted side: it is handed candidate-shaped input and its
 * stdout comes back into the host, so these cases pin what the host refuses
 * rather than what a well-behaved worker happens to print.
 */
async function withWorker(sources, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-worker-'));
  try {
    const workerPath = join(dir, 'worker.mjs');
    writeFileSync(workerPath, `process.stdout.write(${JSON.stringify(sources)} + '\\n');\n`);
    return await run(workerPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const input = { visitedNodes: [], boundaryMissCount: 0, totalAttempts: 0, criticalPathMs: 1 };

test('a worker that answers with a non-object result is refused', async () => {
  await withWorker(JSON.stringify({ result: 42 }), (workerPath) =>
    assert.rejects(evaluateReplayIsolated(input, undefined, { workerPath }), /returned a non-object result/)
  );
});

test('a worker whose result is missing a metric is refused by name', async () => {
  await withWorker(JSON.stringify({ result: { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0 } }), (workerPath) =>
    assert.rejects(evaluateReplayIsolated(input, undefined, { workerPath }), /returned an invalid score/)
  );
});

test('a worker whose metric is not a finite number is refused', async () => {
  for (const bad of ['1', null, [], {}]) {
    await withWorker(
      JSON.stringify({ result: { quality: bad, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1 } }),
      (workerPath) =>
        assert.rejects(evaluateReplayIsolated(input, undefined, { workerPath }), /returned an invalid quality/)
    );
  }
});

test('a metric that overflows to infinity is refused', async () => {
  // JSON has no NaN or Infinity literal, but 1e999 parses to Infinity, so a
  // worker can hand the host a non-finite number without breaking JSON. Without
  // the finiteness check it would flow into a score.
  await withWorker(
    '{"result":{"quality":1,"cost":0,"parallelEfficiency":1,"missRate":0,"score":1e999}}',
    (workerPath) => assert.rejects(evaluateReplayIsolated(input, undefined, { workerPath }), /returned an invalid score/)
  );
});

test('a worker result is rebuilt field by field, so extra properties do not cross', async () => {
  await withWorker(
    JSON.stringify({
      result: { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1, evil: true, __proto__: { polluted: true } }
    }),
    async (workerPath) => {
      const result = await evaluateReplayIsolated(input, undefined, { workerPath });
      assert.deepEqual(result, { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1 });
      assert.equal('evil' in result, false);
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.equal({}.polluted, undefined, 'a crafted key must not reach Object.prototype');
    }
  );
});
