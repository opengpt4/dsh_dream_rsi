import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOCK_CAPABILITY_PROFILE,
  MOCK_FRAME_ID,
  OBSERVATION_SCHEMA_VERSION,
  MockEmbodiedBackend,
  MockEnvironmentAdapter,
  createDreamRsiRuntime,
  resolveDreamRsiConfig
} from '../dist/index.js';
import { createPerceiveTool } from '../dist/embodied/perceive.js';

function tool(adapter = new MockEnvironmentAdapter(new MockEmbodiedBackend())) {
  return { adapter, perceive: createPerceiveTool(adapter) };
}

function exec(signal) {
  return { callId: 'call-1', signal: signal ?? new AbortController().signal };
}

test('the adapter declares the capability profile it is held to', () => {
  const adapter = new MockEnvironmentAdapter(new MockEmbodiedBackend());
  assert.deepEqual(adapter.capability(), MOCK_CAPABILITY_PROFILE);
  // Sensors included: a caller cannot ask for one the backend never declared.
  assert.ok(adapter.capability().sensors.includes('pose'));
});

test('an observation reports its coordinate frame and schema version', async () => {
  const { perceive } = tool();
  const result = await perceive.execute({ session_id: 'session-1' }, exec());

  // Without the frame a pose is an ambiguous triple of numbers, and without the
  // version a consumer cannot tell which schema it is reading.
  assert.equal(result.frame_id, MOCK_FRAME_ID);
  assert.equal(result.schema_version, OBSERVATION_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(result.pose), ['x', 'y', 'z', 'yaw']);
  assert.equal(result.objects.length, 2);
});

test('the pose and the objects can be excluded independently', async () => {
  const { perceive } = tool();

  const noPose = await perceive.execute({ session_id: 'session-1', include_pose: false }, exec());
  assert.equal(noPose.pose, undefined);
  assert.equal(noPose.objects.length, 2);

  const noObjects = await perceive.execute({ session_id: 'session-1', include_objects: false }, exec());
  assert.equal(noObjects.objects, undefined);
  assert.ok(noObjects.pose);
});

test('sensor_types restricts what is read', async () => {
  const { perceive } = tool();

  const objectsOnly = await perceive.execute({ session_id: 'session-1', sensor_types: ['objects'] }, exec());
  assert.equal(objectsOnly.pose, undefined);
  assert.equal(objectsOnly.objects.length, 2);
  // The frame and version are reported whichever sensors were read.
  assert.equal(objectsOnly.frame_id, MOCK_FRAME_ID);

  const poseOnly = await perceive.execute({ session_id: 'session-1', sensor_types: ['pose'] }, exec());
  assert.ok(poseOnly.pose);
  assert.equal(poseOnly.objects, undefined);
});

test('an undeclared sensor is refused rather than silently ignored', async () => {
  const { perceive } = tool();

  await assert.rejects(
    perceive.execute({ session_id: 'session-1', sensor_types: ['lidar'] }, exec()),
    /sensor\(s\) not declared by the capability profile: lidar; declared sensors are pose, gripper, objects/
  );

  // One undeclared sensor in a list is enough to refuse the whole request.
  await assert.rejects(
    perceive.execute({ session_id: 'session-1', sensor_types: ['pose', 'depth'] }, exec()),
    /sensor\(s\) not declared by the capability profile: depth/
  );
});

test('every sensor the profile declares can actually be read', async () => {
  const { perceive } = tool();

  // A sensor named in `sensor_types` must appear in the output. Accepting
  // `gripper` and reporting nothing for it made the request a silent no-op
  // against a capability the backend explicitly declares.
  const outputKeyFor = { pose: 'pose', objects: 'objects', gripper: 'gripper' };

  for (const sensor of MOCK_CAPABILITY_PROFILE.sensors) {
    const key = outputKeyFor[sensor];
    assert.ok(key, `the profile declares ${sensor} but this test does not know its output key`);

    const result = await perceive.execute({ session_id: 'session-1', sensor_types: [sensor] }, exec());
    assert.ok(result[key] !== undefined, `sensor_types ['${sensor}'] returned no ${key}`);
  }
});

test('the gripper is reported by default and excluded on request', async () => {
  const { perceive } = tool();

  const byDefault = await perceive.execute({ session_id: 'session-1' }, exec());
  assert.equal(byDefault.gripper, 'open');

  const excluded = await perceive.execute({ session_id: 'session-1', sensor_types: ['pose'] }, exec());
  assert.equal(excluded.gripper, undefined);
});

test('a cancelled perceive does not reach the environment', async () => {
  const { perceive } = tool();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    perceive.execute({ session_id: 'session-1' }, exec(controller.signal)),
    /cancelled before execution/
  );
});

test('the tool reaches the environment through the adapter contract only', async () => {
  const calls = [];
  const inner = new MockEnvironmentAdapter(new MockEmbodiedBackend());
  const spy = {
    capability: () => inner.capability(),
    observe: async (request) => {
      calls.push(request);
      return inner.observe(request);
    },
    availableActions: () => inner.availableActions(),
    execute: (request, signal) => inner.execute(request, signal),
    emergencyStop: (sessionId) => inner.emergencyStop(sessionId),
    reset: (sessionId) => inner.reset(sessionId),
    releaseAllSessions: () => inner.releaseAllSessions()
  };

  const perceive = createPerceiveTool(spy);
  await perceive.execute({ session_id: 'session-1', include_objects: false }, exec());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: 'session-1', correlationId: 'call-1', includeObjects: false });
});

test('a runtime-built perceive tool reports the runtime adapter frame', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const perceive = createPerceiveTool(runtime.adapter);
    const result = await perceive.execute({ session_id: 'session-1' }, exec());
    assert.equal(result.frame_id, MOCK_FRAME_ID);
  } finally {
    runtime.dispose();
  }
});
