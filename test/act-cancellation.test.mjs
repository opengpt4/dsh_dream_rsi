import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  ActionGuard,
  MOCK_CAPABILITY_PROFILE,
  MockEmbodiedBackend,
  MockEnvironmentAdapter
} from '../dist/index.js';
import { createActTool } from '../dist/embodied/act.js';

const MOVE = { action_type: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } };

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

function makeTool(latencyMs, guardOptions = {}, context = fakeCtx()) {
  const backend = new MockEmbodiedBackend(latencyMs);
  const adapter = new MockEnvironmentAdapter(backend);
  const guard = new ActionGuard({
    profile: MOCK_CAPABILITY_PROFILE,
    actionLeaseMs: 30_000,
    maxActionsPerMinute: 30,
    requireConfirmation: true,
    ...guardOptions
  });
  return { backend, adapter, guard, context, tool: createActTool(context, adapter, guard) };
}

test('embodied_act times out a slow action and leaves state unmutated', async () => {
  const { backend, tool } = makeTool(50);

  const result = await tool.execute({ session_id: 'session-a', ...MOVE, timeout_ms: 10 }, fakeExec());

  assert.equal(result.success, false);
  assert.equal(result.status, 'timeout');
  assert.equal(result.state, 'TIMEOUT');
  assert.equal(backend.queryState('session-a').pose.x, 0);
});

test('embodied_act cancels an in-flight action via the caller abort signal and leaves state unmutated', async () => {
  const { backend, tool } = makeTool(50);
  const controller = new AbortController();

  const pending = tool.execute({ session_id: 'session-a', ...MOVE, timeout_ms: 1000 }, fakeExec(controller.signal));
  await delay(5);
  controller.abort();
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(backend.queryState('session-a').pose.x, 0);
});

test('embodied_act still completes a fast action within a generous timeout', async () => {
  const { tool } = makeTool(0);

  const result = await tool.execute({ session_id: 'session-a', ...MOVE, timeout_ms: 1000 }, fakeExec());

  assert.equal(result.success, true);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.status, 'completed');
  assert.equal(result.result.step, 1);
});

// The four `embodied/*` events are the plugin's interface to a host. Their
// payload types are checked by the compiler through the Cordis `Events`
// augmentation, but nothing asserted that they fire — `fakeCtx` collected them
// into an array no test read, so dropping `embodied/frame` or emitting
// `action-completed` for a failed action would have passed the whole suite.

test('a completed action emits started, completed, and the frame it advanced', async () => {
  const context = fakeCtx();
  const { tool } = makeTool(0, {}, context);

  const result = await tool.execute({ session_id: 'session-a', ...MOVE }, fakeExec());

  assert.deepEqual(context.emitted.map((entry) => entry.event), [
    'embodied/action-started',
    'embodied/action-completed',
    'embodied/frame'
  ]);
  const [started, completed, frame] = context.emitted;
  // The action id is session-scoped, and the same id names the action in every
  // event, so a host can correlate them.
  assert.deepEqual(started.payload, { actionId: 'session-a:call-1', sessionId: 'session-a', actionType: 'move_relative' });
  assert.equal(completed.payload.actionId, started.payload.actionId);
  assert.equal(completed.payload.result.status, 'completed');
  assert.deepEqual(frame.payload, { sessionId: 'session-a', step: result.result.step });
});

test('a refused action emits started and an error, and never a frame', async () => {
  const context = fakeCtx();
  const { tool } = makeTool(0, {}, context);

  const result = await tool.execute({ session_id: 'session-a', action_type: 'fly', parameters: {} }, fakeExec());

  assert.equal(result.success, false);
  assert.deepEqual(context.emitted.map((entry) => entry.event), ['embodied/action-started', 'embodied/error']);
  assert.equal(context.emitted[1].payload.actionId, 'session-a:call-1');
  assert.match(context.emitted[1].payload.error, /not part of the MVP action vocabulary/);
});

test('a cancelled action emits started and an error carrying the cancellation', async () => {
  const controller = new AbortController();
  const context = fakeCtx();
  const { tool } = makeTool(50, {}, context);

  const pending = tool.execute({ session_id: 'session-a', ...MOVE, timeout_ms: 30_000 }, fakeExec(controller.signal));
  controller.abort();
  const result = await pending;

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(context.emitted.map((entry) => entry.event), ['embodied/action-started', 'embodied/error']);
  assert.match(context.emitted[1].payload.error, /cancel/i);
});

// A tool session is not an episode, so the record carries no task or episode id.
test('an interactive action records a trace id without inventing a task or episode', async () => {
  const { guard, tool } = makeTool(0);

  await tool.execute({ session_id: 'session-a', ...MOVE, timeout_ms: 1000 }, fakeExec());

  const [record] = guard.list();
  assert.equal(record.correlationId, 'session-a:call-1');
  assert.equal(record.taskId, undefined);
  assert.equal(record.episodeId, undefined);
});

test('embodied_act refuses an action whose capability requires confirmation', async () => {
  const { backend, guard, tool } = makeTool(0);

  const result = await tool.execute(
    { session_id: 'session-a', action_type: 'pick', parameters: { objectId: 'red-mug' }, timeout_ms: 1000 },
    fakeExec()
  );

  assert.equal(result.success, false);
  assert.equal(result.rejection_code, 'confirmation_required');
  assert.equal(result.state, 'FAILED');
  assert.equal(guard.list().length, 0, 'a rejection is not recorded as an action');
  assert.equal(backend.queryState('session-a').gripper, 'open');
});

test('embodied_act admits a high-risk action when the host approves it', async () => {
  const { backend, tool } = makeTool(0, { confirm: (request) => request.token === 'token-1' });

  const result = await tool.execute(
    {
      session_id: 'session-a',
      action_type: 'pick',
      parameters: { objectId: 'red-mug' },
      timeout_ms: 1000,
      confirmation_token: 'token-1'
    },
    fakeExec()
  );

  assert.equal(result.success, true);
  assert.equal(backend.queryState('session-a').gripper, 'closed');
});

test('embodied_act refuses an action outside the capability profile', async () => {
  const { tool } = makeTool(0);

  const result = await tool.execute(
    { session_id: 'session-a', action_type: 'teleport', parameters: {}, timeout_ms: 1000 },
    fakeExec()
  );

  assert.equal(result.success, false);
  assert.equal(result.rejection_code, 'action_not_declared');
});

test('embodied_act refuses a parameter beyond the declared limit', async () => {
  const { backend, tool } = makeTool(0);

  const result = await tool.execute(
    { session_id: 'session-a', action_type: 'move_relative', parameters: { dx: 50 }, timeout_ms: 1000 },
    fakeExec()
  );

  assert.equal(result.success, false);
  assert.equal(result.rejection_code, 'limit_exceeded');
  assert.equal(backend.queryState('session-a').pose.x, 0);
});

test('embodied_act is refused once the session is stopped', async () => {
  const { guard, tool } = makeTool(0);
  guard.emergencyStop('session-a', 'operator pressed stop');

  const result = await tool.execute({ session_id: 'session-a', ...MOVE, timeout_ms: 1000 }, fakeExec());

  assert.equal(result.success, false);
  assert.equal(result.rejection_code, 'session_stopped');
});
