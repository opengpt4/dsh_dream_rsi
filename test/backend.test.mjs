import assert from 'node:assert/strict';
import test from 'node:test';

import { MockEmbodiedBackend } from '../dist/embodied/backend.js';

test('keeps mock environment state isolated by session', () => {
  const backend = new MockEmbodiedBackend();

  const first = backend.observe('session-a');
  const second = backend.observe('session-b');

  assert.equal(first.sessionId, 'session-a');
  assert.equal(second.sessionId, 'session-b');
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(first.environmentId, 'mock-room-v1');
});

test('reset removes a session without affecting another session', () => {
  const backend = new MockEmbodiedBackend();

  const beforeReset = backend.observe('session-a');
  backend.observe('session-b');
  backend.reset('session-a');
  const afterReset = backend.observe('session-a');

  assert.equal(beforeReset.step, 0);
  assert.equal(afterReset.step, 0);
});

test('executes a high-level action and exposes the updated state', async () => {
  const backend = new MockEmbodiedBackend();

  const result = await backend.execute('session-a', 'move_relative', { dx: 1, dy: 2, dz: 0 });
  const state = backend.queryState('session-a');

  assert.equal(result.step, 1);
  assert.deepEqual(state.pose, { x: 1, y: 2, z: 0, yaw: 0 });
  assert.equal(state.gripper, 'open');
});

test('keeps action state isolated between sessions', async () => {
  const backend = new MockEmbodiedBackend();

  await backend.execute('session-a', 'pick', {});

  assert.equal(backend.queryState('session-a').gripper, 'closed');
  assert.equal(backend.queryState('session-b').gripper, 'open');
});

test('rejects execute when the signal is already aborted, without mutating state', async () => {
  const backend = new MockEmbodiedBackend(50);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    backend.execute('session-a', 'pick', {}, controller.signal),
    /cancelled/
  );
  assert.equal(backend.queryState('session-a').gripper, 'open');
});

test('rejects an in-flight execute when aborted mid-latency, without mutating state', async () => {
  const backend = new MockEmbodiedBackend(50);
  const controller = new AbortController();

  const pending = backend.execute('session-a', 'pick', {}, controller.signal);
  controller.abort();

  await assert.rejects(pending, /cancelled/);
  assert.equal(backend.queryState('session-a').gripper, 'open');
});