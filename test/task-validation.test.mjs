import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryDiscoveryStore, validateTask, runEpisode } from '../dist/index.js';

/**
 * `validateTask` is the gate that stops a malformed task from being run at all.
 * None of its five rules had a test, and no test referenced the function.
 */

function task(overrides = {}) {
  return {
    taskId: 'task-1',
    goal: 'reach x=1',
    environmentId: 'mock-room-v1',
    policyVersion: 'v1',
    budget: { maxSteps: 3, wallClockMs: 30_000 },
    metadata: {},
    ...overrides
  };
}

/** An adapter that records every read and refuses to do anything else. */
function spyAdapter() {
  const calls = [];
  return {
    calls,
    adapter: {
      capability: () => ({ sensors: ['pose'], actions: ['move_relative'] }),
      observe: async (request) => {
        calls.push(request);
        throw new Error('the environment should not have been read');
      },
      availableActions: async () => [],
      execute: async () => {
        throw new Error('the environment should not have been executed against');
      },
      emergencyStop: async () => {},
      releaseAllSessions: () => {},
      reset: () => {}
    }
  };
}

test('a task needs identifiers, a policy version, and a positive budget', () => {
  for (const [label, value, message] of [
    ['blank taskId', task({ taskId: '  ' }), /task\.taskId must not be empty/],
    ['blank environmentId', task({ environmentId: '' }), /task\.environmentId must not be empty/],
    ['blank policyVersion', task({ policyVersion: ' ' }), /task\.policyVersion must not be empty/],
    ['maxSteps 0', task({ budget: { maxSteps: 0, wallClockMs: 1_000 } }), /task\.budget\.maxSteps must be a positive integer/],
    ['maxSteps fractional', task({ budget: { maxSteps: 1.5, wallClockMs: 1_000 } }), /task\.budget\.maxSteps must be a positive integer/],
    ['maxSteps NaN', task({ budget: { maxSteps: Number.NaN, wallClockMs: 1_000 } }), /task\.budget\.maxSteps must be a positive integer/],
    ['wallClockMs 0', task({ budget: { maxSteps: 1, wallClockMs: 0 } }), /task\.budget\.wallClockMs must be positive/],
    ['wallClockMs negative', task({ budget: { maxSteps: 1, wallClockMs: -1 } }), /task\.budget\.wallClockMs must be positive/],
    ['wallClockMs infinite', task({ budget: { maxSteps: 1, wallClockMs: Number.POSITIVE_INFINITY } }), /task\.budget\.wallClockMs must be positive/]
  ]) {
    assert.throws(() => validateTask(value), message, label);
  }

  // The boundaries that are legal, so the rules are not simply refusing.
  assert.doesNotThrow(() => validateTask(task()));
  assert.doesNotThrow(() => validateTask(task({ budget: { maxSteps: 1, wallClockMs: 1 } })));
});

test('a malformed task is refused before the environment is read', async () => {
  const spy = spyAdapter();

  await assert.rejects(
    runEpisode({
      task: task({ taskId: '' }),
      episodeId: 'episode-1',
      sessionId: 'session-1',
      adapter: spy.adapter,
      store: new InMemoryDiscoveryStore(),
      policy: () => null
    }),
    /task\.taskId must not be empty/
  );
  assert.deepEqual(spy.calls, [], 'a malformed task reached the environment');

  // The counter-check: a well-formed task does read, so the assertion above is
  // about ordering rather than about an adapter nothing ever calls. The policy
  // returns null, which ends the episode on its first observation.
  const reachable = spyAdapter();
  reachable.adapter.observe = async (request) => {
    reachable.calls.push(request);
    return {
      sessionId: request.sessionId,
      environmentId: 'mock-room-v1',
      environmentVersion: 'mock-room-v1@1',
      frameId: 'mock-room-v1/world',
      step: 0,
      pose: { x: 0, y: 0, z: 0, yaw: 0 },
      gripper: 'open',
      objects: [],
      schemaVersion: 1,
      timestamp: '2026-01-01T00:00:00.000Z'
    };
  };
  const outcome = await runEpisode({
    task: task(),
    episodeId: 'episode-2',
    sessionId: 'session-2',
    adapter: reachable.adapter,
    store: new InMemoryDiscoveryStore(),
    policy: () => null
  });

  assert.equal(reachable.calls.length, 1);
  assert.equal(outcome.episode.status, 'failed');
  assert.match(outcome.cause, /policy exhausted/);
});
