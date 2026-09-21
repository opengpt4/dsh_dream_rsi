import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { MockEmbodiedBackend } from '../dist/embodied/backend.js';
import { createActTool } from '../dist/embodied/act.js';

function fakeCtx() {
  const emitted = [];
  return {
    emitted,
    emit(event, payload) {
      emitted.push({ event, payload });
    }
  };
}

function fakeExec(signal) {
  return { callId: 'call-1', signal: signal ?? new AbortController().signal };
}

test('embodied_act times out a slow action and leaves state unmutated', async () => {
  const backend = new MockEmbodiedBackend(50);
  const ctx = fakeCtx();
  const tool = createActTool(ctx, backend);

  const result = await tool.execute(
    { session_id: 'session-a', action_type: 'pick', parameters: {}, timeout_ms: 10 },
    fakeExec()
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'action timed out');
  assert.equal(backend.queryState('session-a').gripper, 'open');
});

test('embodied_act cancels an in-flight action via the caller abort signal and leaves state unmutated', async () => {
  const backend = new MockEmbodiedBackend(50);
  const ctx = fakeCtx();
  const tool = createActTool(ctx, backend);
  const controller = new AbortController();

  const pending = tool.execute(
    { session_id: 'session-a', action_type: 'pick', parameters: {}, timeout_ms: 1000 },
    fakeExec(controller.signal)
  );
  await delay(5);
  controller.abort();
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(result.error, 'action cancelled');
  assert.equal(backend.queryState('session-a').gripper, 'open');
});

test('embodied_act still completes a fast action within a generous timeout', async () => {
  const backend = new MockEmbodiedBackend(0);
  const ctx = fakeCtx();
  const tool = createActTool(ctx, backend);

  const result = await tool.execute(
    { session_id: 'session-a', action_type: 'pick', parameters: {}, timeout_ms: 1000 },
    fakeExec()
  );

  assert.equal(result.success, true);
  assert.equal(result.result.gripper, 'closed');
  assert.deepEqual(
    ctx.emitted.map((entry) => entry.event),
    ['embodied/action-started', 'embodied/action-completed', 'embodied/frame']
  );
});
