import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateReplayIsolated } from '../dist/evolution/isolated-evaluator.js';
import { runIsolatedChild } from '../dist/operations/isolated-child.js';
import {
  MOCK_ENVIRONMENT_ID,
  createDreamRsiRuntime,
  getDreamRsiStatus,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runEpisodePipeline
} from '../dist/index.js';

const input = { visitedNodes: [], boundaryMissCount: 0, totalAttempts: 0, criticalPathMs: 1 };

/**
 * A stand-in for the runtime a host would name.
 *
 * It records the command line it was handed, then runs it with its own stdio
 * inherited, so the child protocol is unchanged. That is what makes the seam
 * testable without a container runtime installed: the plugin's contract is the
 * argv it builds, and that is what this asserts.
 */
const STUB = `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [logPath, ...rest] = process.argv.slice(2);
// Like a real runtime: consume the flags that are ours, then run the rest.
const isFlag = (argument) => argument.startsWith('--fake-');
const flags = rest.filter(isFlag);
const command = rest.filter((argument) => !isFlag(argument));
appendFileSync(logPath, JSON.stringify({ flags, command }) + '\\n');
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`;

/** Awaited, not merely called: the synchronous form tears the directory down mid-await. */
async function withStub(run, body = STUB) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-sandbox-'));
  try {
    const stubPath = join(dir, 'runtime.mjs');
    const logPath = join(dir, 'argv.log');
    writeFileSync(stubPath, body);
    writeFileSync(logPath, '');
    return await run({
      dir,
      stubPath,
      logPath,
      recorded: () =>
        readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the evaluator child is launched through the runtime the host named', async () => {
  await withStub(async ({ stubPath, logPath, recorded }) => {
    const result = await evaluateReplayIsolated(input, undefined, {
      sandbox: { command: process.execPath, args: [stubPath, logPath, '--fake-unshare-net'] }
    });

    // The result is the same one the direct launch produces: the sandbox wraps
    // the child, it does not replace the protocol.
    assert.deepEqual(result, { quality: 0, cost: 0, parallelEfficiency: 0, missRate: 0, score: 0 });

    const [invocation] = recorded();
    // The runtime's own flags come before the child command line, which is the
    // plugin's whole contract with it.
    assert.deepEqual(invocation.flags, ['--fake-unshare-net']);
    const { command } = invocation;
    assert.match(command[0], /node$/, 'the child executable follows the runtime flags');
    assert.ok(command.includes('--max-old-space-size=512'), 'the heap ceiling still applies inside the sandbox');
    assert.match(command.at(-1), /evaluator-worker\.js$/, 'the entry point is last');
  });
});

test('a runtime that cannot run the child fails the evaluation rather than silently succeeding', async () => {
  await withStub(
    async ({ stubPath, logPath }) => {
      await assert.rejects(
        evaluateReplayIsolated(input, undefined, { sandbox: { command: process.execPath, args: [stubPath, logPath] } }),
        /isolated evaluator exited with code 7/
      );
    },
    `process.exit(7);\n`
  );
});

test('an empty sandbox command is refused instead of running the child unconfined', async () => {
  await assert.rejects(
    runIsolatedChild({
      entryPath: 'unused.js',
      label: 'isolated evaluator',
      timeoutMs: 1_000,
      sandbox: { command: '   ', args: [] }
    }),
    /sandbox command must not be empty/
  );
});

// ------------------------------------------------------------ configuration

test('the sandbox is configuration, and arguments without a runtime are refused', () => {
  const bare = resolveDreamRsiConfig({});
  assert.equal(bare.evaluation.sandboxCommand, '');
  assert.deepEqual(bare.evaluation.sandboxArgs, []);

  const configured = resolveDreamRsiConfig({
    evaluation: { sandboxCommand: 'bwrap', sandboxArgs: ['--unshare-net', '--die-with-parent'] }
  });
  assert.equal(configured.evaluation.sandboxCommand, 'bwrap');
  assert.deepEqual(configured.evaluation.sandboxArgs, ['--unshare-net', '--die-with-parent']);

  assert.throws(
    () => resolveDreamRsiConfig({ evaluation: { sandboxArgs: ['--unshare-net'] } }),
    /require evaluation\.sandboxCommand/
  );
  assert.throws(
    () => resolveDreamRsiConfig({ evaluation: { sandboxCommand: 'bwrap', sandboxArgs: ['  '] } }),
    /must not contain an empty argument/
  );
});

test('the configured runtime reaches the pipeline settings and the status report', async () => {
  const runtime = createDreamRsiRuntime(
    resolveDreamRsiConfig({
      storage: { sqlitePath: ':memory:' },
      evaluation: { sandboxCommand: 'docker', sandboxArgs: ['run', '--network', 'none'] }
    })
  );
  try {
    // What the pipeline would launch the child with.
    assert.deepEqual(pipelineSettings(runtime).evaluatorSandbox, {
      command: 'docker',
      args: ['run', '--network', 'none']
    });

    // And what an operator can read: the runtime's flags are where CPU and
    // network limits live, so the report has to name them.
    const status = getDreamRsiStatus(runtime.config, runtime);
    assert.deepEqual(status.resources.sandbox, { command: 'docker', args: ['run', '--network', 'none'] });
    const tool = (await import('../dist/status.js')).createStatusTool(runtime.config, runtime);
    const result = await tool.execute({}, { callId: 'call-1', signal: new AbortController().signal });
    assert.equal(result.resources.sandbox_command, 'docker');
    assert.deepEqual(result.resources.sandbox_args, ['run', '--network', 'none']);
  } finally {
    runtime.dispose();
  }

  const bare = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    assert.equal(pipelineSettings(bare).evaluatorSandbox, undefined);
    assert.equal(getDreamRsiStatus(bare.config).resources.sandbox, null);
  } finally {
    bare.dispose();
  }
});

test('a run with an isolated evaluator launches the child through the configured runtime', async () => {
  await withStub(async ({ stubPath, logPath, recorded }) => {
    const runtime = createDreamRsiRuntime(
      resolveDreamRsiConfig({
        storage: { sqlitePath: ':memory:' },
        evaluation: { sandboxCommand: process.execPath, sandboxArgs: [stubPath, logPath, '--fake-netless'] }
      })
    );
    try {
      const result = await runEpisodePipeline({
        task: {
          taskId: 'task-sandbox',
          goal: 'reach x=1',
          environmentId: MOCK_ENVIRONMENT_ID,
          policyVersion: 'policy-v1',
          budget: { maxSteps: 3, wallClockMs: 60_000 },
          metadata: {}
        },
        episodeId: 'episode-sandbox',
        sessionId: 'session-sandbox',
        adapter: runtime.adapter,
        store: runtime.store,
        guard: runtime.guard,
        policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }]),
        isGoalReached: (observation) => observation.pose.x >= 1,
        settings: pipelineSettings(runtime),
        isolated: true
      });

      assert.equal(result.outcome.episode.status, 'completed');
      // The whole chain: configuration reaches the runtime, the runtime's
      // settings reach the pipeline, and the pipeline launches the child
      // through the runtime the host named.
      const [invocation] = recorded();
      assert.deepEqual(invocation.flags, ['--fake-netless']);
      assert.match(invocation.command.at(-1), /evaluator-worker\.js$/);
      // The metrics come from the child; what this test is about is that the
      // child ran at all, and ran through the named runtime.
      assert.equal(typeof result.evaluation.score, 'number');
      assert.equal(Number.isFinite(result.evaluation.score), true);
    } finally {
      runtime.dispose();
    }
  });
});
