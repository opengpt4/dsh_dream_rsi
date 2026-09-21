import assert from 'node:assert/strict';
import test from 'node:test';

import { MockEmbodiedBackend, MockEnvironmentAdapter } from '../dist/index.js';
import { createQueryStateTool } from '../dist/embodied/query-state.js';

function tool(adapter = new MockEnvironmentAdapter(new MockEmbodiedBackend())) {
  return { adapter, queryState: createQueryStateTool(adapter) };
}

function exec(signal) {
  return { callId: 'call-1', signal: signal ?? new AbortController().signal };
}

/** An adapter that records every read, with one fixed observation. */
function spyAdapter(overrides = {}) {
  const calls = [];
  const observation = {
    sessionId: 'session-1',
    environmentId: 'mock-room-v1',
    environmentVersion: 'mock-room-v1@1',
    frameId: 'mock-room-v1/world',
    step: 3,
    pose: { x: 1, y: 2, z: 3, yaw: 0 },
    gripper: 'closed',
    objects: [{ id: 'red-mug', label: 'red mug', position: [1, 0, 0] }],
    schemaVersion: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
  return {
    calls,
    observation,
    adapter: {
      capability: () => new MockEnvironmentAdapter(new MockEmbodiedBackend()).capability(),
      observe: async (request) => {
        calls.push(request);
        return observation;
      },
      availableActions: async () => ['move_relative'],
      execute: async () => {
        throw new Error('not used');
      },
      emergencyStop: async () => {},
      releaseAllSessions: () => {}
    }
  };
}

// The tool was covered only by the tests that assert it registers. None of its
// three modes, its rejection path, or its cancellation check was exercised.

test('each query projects exactly one part of the state', async () => {
  const { queryState } = tool();

  const objects = await queryState.execute({ session_id: 'session-1', query: 'objects' }, exec());
  assert.deepEqual(Object.keys(objects), ['session_id', 'query', 'value']);
  assert.equal(objects.session_id, 'session-1');
  assert.equal(objects.query, 'objects');
  assert.deepEqual(Object.keys(objects.value), ['objects']);
  assert.deepEqual(objects.value.objects.map((object) => object.id), ['red-mug', 'wooden-table']);

  const pose = await queryState.execute({ session_id: 'session-1', query: 'pose' }, exec());
  assert.deepEqual(Object.keys(pose.value), ['pose']);
  assert.deepEqual(pose.value.pose, { x: 0, y: 0, z: 0, yaw: 0 });

  const gripper = await queryState.execute({ session_id: 'session-1', query: 'gripper' }, exec());
  assert.deepEqual(Object.keys(gripper.value), ['gripper']);
  assert.equal(gripper.value.gripper, 'open');
});

test('an unanswerable query is refused before the environment is read', async () => {
  // Observing is what creates the session in a backend, so a rejected query that
  // had already read left environment state behind for a request nothing could
  // answer. `embodied_perceive` validates its sensor list first for the same
  // reason.
  const spy = spyAdapter();
  const queryState = createQueryStateTool(spy.adapter);

  await assert.rejects(
    queryState.execute({ session_id: 'session-1', query: 'not-a-sensor' }, exec()),
    /query must be one of: objects, pose, gripper/
  );
  assert.deepEqual(spy.calls, [], 'the environment was read for a query that cannot be answered');

  // The counter-check: a valid query does read, so the assertion above is about
  // ordering rather than about a tool that never reads at all.
  await queryState.execute({ session_id: 'session-1', query: 'pose' }, exec());
  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0], { sessionId: 'session-1', correlationId: 'call-1', includeObjects: true });
});

test('a cancelled query reads nothing', async () => {
  const spy = spyAdapter();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    createQueryStateTool(spy.adapter).execute({ session_id: 'session-1', query: 'pose' }, exec(controller.signal)),
    /cancelled/
  );
  assert.deepEqual(spy.calls, []);
});

test('the projection copies the state rather than aliasing it', async () => {
  const spy = spyAdapter();
  const queryState = createQueryStateTool(spy.adapter);

  const objects = await queryState.execute({ session_id: 'session-1', query: 'objects' }, exec());
  const pose = await queryState.execute({ session_id: 'session-1', query: 'pose' }, exec());

  // A caller editing what it was handed must not edit the environment's state.
  objects.value.objects[0].position[0] = 99;
  pose.value.pose.x = 99;
  assert.equal(spy.observation.objects[0].position[0], 1);
  assert.equal(spy.observation.pose.x, 1);
});

test('the same tool reads whichever adapter it was given', async () => {
  // The name says mock, but the tool depends on the adapter contract rather than
  // the mock SDK: any backend that declares and observes is usable.
  const spy = spyAdapter({ gripper: 'closed' });
  const result = await createQueryStateTool(spy.adapter).execute(
    { session_id: 'other-session', query: 'gripper' },
    exec()
  );

  assert.equal(result.session_id, 'other-session');
  assert.equal(result.value.gripper, 'closed');
});
