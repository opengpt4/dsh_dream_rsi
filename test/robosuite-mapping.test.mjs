import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROBOSUITE_FRAME_ID,
  toActionStatus,
  toActionResult,
  toBridgeRequest,
  toObservation
} from '../dist/embodied/robosuite-mapping.js';
import { OBSERVATION_SCHEMA_VERSION, assertObservationSchema } from '../dist/embodied/protocol.js';

const IDENTITY = {
  sessionId: 'session-1',
  environmentId: 'Lift',
  environmentVersion: 'robosuite-1.5.2'
};
const AT = '2026-01-01T00:00:00.000Z';

const state = (overrides = {}) => ({
  step: 3,
  pose: { x: 0.1, y: -0.2, z: 1.05, yaw: 0.25 },
  gripper: 'open',
  objects: { cube: [0.0, 0.0, 0.82] },
  status: 'completed',
  ...overrides
});

test('bridge state becomes the observation the plugin records', () => {
  const observation = toObservation(IDENTITY, state(), AT);

  assertObservationSchema(observation);
  assert.equal(observation.frameId, ROBOSUITE_FRAME_ID);
  assert.equal(observation.schemaVersion, OBSERVATION_SCHEMA_VERSION);
  assert.equal(observation.step, 3);
  assert.deepEqual(observation.pose, { x: 0.1, y: -0.2, z: 1.05, yaw: 0.25 });
  assert.equal(observation.gripper, 'open');
  assert.deepEqual(observation.objects, [{ id: 'cube', label: 'cube', position: [0, 0, 0.82] }]);
  assert.equal(observation.timestamp, AT);
  assert.equal(observation.environmentVersion, 'robosuite-1.5.2');
});

test('malformed child state is refused rather than defaulted', () => {
  // The state crosses a process boundary, so it is validated and rebuilt field
  // by field. A defaulted pose would be recorded as an observation the
  // environment never produced, and every replay and score would rest on it.
  const cases = [
    [state({ pose: undefined }), /carries no pose/],
    [state({ pose: { x: Number.NaN, y: 0, z: 0, yaw: 0 } }), /pose\.x is not a finite number/],
    [state({ pose: { x: 0, y: 0, z: 0, yaw: Number.POSITIVE_INFINITY } }), /pose\.yaw is not a finite number/],
    [state({ gripper: 'ajar' }), /gripper is neither open nor closed/],
    [state({ step: 'three' }), /step is not a finite number/],
    [state({ objects: { cube: [1, 2] } }), /cube is not a three-number position/],
    [state({ objects: { cube: [1, 2, 'z'] } }), /cube\.z is not a finite number/],
    [null, /state is not an object/]
  ];
  for (const [bad, expected] of cases) {
    assert.throws(() => toObservation(IDENTITY, bad, AT), expected);
  }
});

test('every action the plugin exposes has a step budget, and nothing else does', () => {
  for (const actionType of ['move_relative', 'goto', 'pick', 'place', 'open']) {
    const request = toBridgeRequest(actionType, { dx: 0.05 });
    assert.equal(request.actionType, actionType);
    assert.deepEqual(request.parameters, { dx: 0.05 });
    assert.ok(Number.isInteger(request.steps) && request.steps > 0, `${actionType} needs a budget`);
  }

  // Refused here, at the boundary the caller controls, rather than sent on a
  // typo and refused there.
  assert.throws(() => toBridgeRequest('teleport', {}), /unsupported action teleport; this adapter implements/);
});

test('an outcome the bridge is not allowed to invent is refused', () => {
  assert.equal(toActionStatus('completed'), 'completed');
  assert.equal(toActionStatus('timeout'), 'timeout');
  assert.equal(toActionStatus('failed'), 'failed');
  // An unknown or absent status must not read as success.
  assert.throws(() => toActionStatus('nearly'), /unknown action status: nearly/);
  assert.throws(() => toActionStatus(undefined), /unknown action status: undefined/);
});

test('an action result carries the outcome, the state, and the identity', () => {
  const result = toActionResult(state({ status: 'timeout' }), {
    actionId: 'action-1',
    completedAt: AT,
    execTimeMs: 12,
    message: 'goto did not reach its target'
  });

  assert.equal(result.actionId, 'action-1');
  assert.equal(result.status, 'timeout');
  assert.equal(result.step, 3);
  assert.equal(result.gripper, 'open');
  assert.deepEqual(result.pose, { x: 0.1, y: -0.2, z: 1.05, yaw: 0.25 });
  assert.equal(result.execTimeMs, 12);
  assert.equal(result.completedAt, AT);
  assert.equal(result.message, 'goto did not reach its target');
});
