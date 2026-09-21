import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ROBOSUITE_FRAME_ID } from '../dist/embodied/robosuite-mapping.js';

/**
 * The RoboSuite bridge, exercised as a process.
 *
 * Skipped unless `DREAM_RSI_SIM_PYTHON` names an interpreter with robosuite
 * installed — the simulator is a host dependency, not a repository one, so the
 * suite stays runnable without it. What the tests assert is the contract the
 * TypeScript adapter will rely on: the commands, the shapes, and that an
 * unusable interpreter is distinguishable from a bad command.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = join(ROOT, 'sim', 'robosuite_bridge.py');
const PYTHON = process.env.DREAM_RSI_SIM_PYTHON;

/** Run the bridge over a whole session's worth of requests, in one process. */
function bridge(requests, options = {}) {
  const result = spawnSync(options.python ?? PYTHON, [BRIDGE], {
    input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, MUJOCO_GL: 'glfw' }
  });
  const responses = result.stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
  return { ...result, responses };
}

const unavailable = PYTHON === undefined || !existsSync(PYTHON);
const skip = unavailable
  ? 'set DREAM_RSI_SIM_PYTHON to an interpreter with robosuite installed'
  : false;

test('the bridge reports what it can build, and on which frame', { skip }, () => {
  const { responses, status } = bridge([{ command: 'capability' }, { command: 'shutdown' }]);

  assert.equal(status, 0);
  assert.match(responses[0].robosuite, /^\d+\.\d+\.\d+$/);
  // Both families the decision selected, so the adapter can refuse a third
  // rather than silently defaulting to one.
  assert.deepEqual(responses[0].environments, ['Lift', 'Stack']);
  assert.equal(responses[0].frame, 'mujoco-world');
});

test('the frame the bridge reports is the one the mapping declares', { skip }, () => {
  // Two halves of one fact, in two languages: the bridge names its frame in
  // `capability`, and the mapping stamps that name onto every observation it
  // builds. Nothing coupled them, so a rename on either side would label
  // observations with a frame the environment does not use.
  const { responses } = bridge([{ command: 'capability' }, { command: 'shutdown' }]);
  assert.equal(responses[0].frame, ROBOSUITE_FRAME_ID);
});

test('a move reaches the axes it was asked for and reports itself complete', { skip }, () => {
  const { responses, status } = bridge([
    { command: 'reset', sessionId: 's1', environment: 'Lift', seed: 7 },
    { command: 'execute', sessionId: 's1', actionType: 'move_relative', parameters: { dx: 0.05, dy: 0, dz: 0.05 }, steps: 20 },
    { command: 'shutdown' }
  ]);

  assert.equal(status, 0);
  const before = responses[0].state.pose;
  const after = responses[1].state;
  // The seed the environment cannot apply is reported as such, rather than
  // looking like one that was honoured.
  assert.equal(responses[0].seedApplied, false);

  assert.ok(after.pose.x > before.x, 'x must move the way it was asked to');
  assert.ok(after.pose.z > before.z, 'z must move the way it was asked to');
  // The fault this pins: commanding the measured orientation as a rotation
  // delta moved y when dy was zero.
  assert.equal(Math.abs(after.pose.y - before.y) < 1e-6, true, 'y must not drift when dy is zero');
  assert.equal(after.status, 'completed');
  assert.ok(after.step <= 20, `the action used ${after.step} of 20 steps`);
  assert.equal(after.gripper, 'open');
  assert.ok(after.objects.cube.length === 3, 'the observed object carries a position');
});

test('a goto lands within tolerance and stops before its budget', { skip }, () => {
  const { responses } = bridge([
    { command: 'reset', sessionId: 's1', environment: 'Lift', seed: 7 },
    { command: 'execute', sessionId: 's1', actionType: 'goto', parameters: { x: 0.0, y: 0.0, z: 1.05 }, steps: 25 },
    { command: 'shutdown' }
  ]);

  const state = responses[1].state;
  assert.equal(state.status, 'completed');
  for (const [axis, target] of [['x', 0.0], ['y', 0.0], ['z', 1.05]]) {
    assert.ok(Math.abs(state.pose[axis] - target) < 0.05, `${axis} is ${state.pose[axis]}, target ${target}`);
  }
  assert.ok(state.step < 25, `arrival must not spend the whole budget, used ${state.step}`);
});

test('a bad command is answered without killing the session', { skip }, () => {
  const { responses, status } = bridge([
    { command: 'reset', sessionId: 's1', environment: 'Lift', seed: 1 },
    { command: 'nonsense' },
    { command: 'observe', sessionId: 's1' },
    { command: 'shutdown' }
  ]);

  assert.equal(status, 0, 'a bad command must not take the process down');
  assert.match(responses[1].error, /unknown command nonsense/);
  // Still usable afterwards: an adapter bug must not strand a live environment.
  assert.equal(responses[2].state.step, 0);
  assert.equal(typeof responses[2].state.pose.x, 'number');
});

test('an action the bridge does not implement is refused without losing the session', { skip }, () => {
  // The plugin's action vocabulary is closed, but the bridge takes its action
  // from a request that could name anything. It must refuse by name and leave
  // the environment usable, rather than stepping something arbitrary.
  const { responses, status } = bridge([
    { command: 'reset', sessionId: 's1', environment: 'Lift', seed: 1 },
    { command: 'execute', sessionId: 's1', actionType: 'teleport', parameters: {}, steps: 5 },
    { command: 'observe', sessionId: 's1' },
    { command: 'shutdown' }
  ]);

  assert.equal(status, 0);
  assert.match(responses[1].error, /unsupported action teleport/);
  assert.equal(responses[2].state.step, 0, 'the refused action must not have stepped the environment');
});

test('an environment the bridge does not build is refused by name', { skip }, () => {
  const { responses } = bridge([
    { command: 'reset', sessionId: 's1', environment: 'Door', seed: 1 },
    { command: 'shutdown' }
  ]);

  assert.match(responses[0].error, /unknown environment Door; this bridge builds Lift, Stack/);
});

test('an interpreter that cannot run the bridge fails loudly rather than silently', () => {
  // Runs everywhere, without the simulator: the adapter has to tell "no
  // simulator here" from "bad request", so an interpreter that cannot start the
  // bridge must not look like a bridge that answered nothing.
  const missing = spawnSync('/nonexistent/python-for-dream-rsi', [BRIDGE], {
    input: '\n',
    encoding: 'utf8'
  });

  assert.equal(missing.status, null, 'the process must never have started');
  assert.equal(missing.error?.code, 'ENOENT');
  // `undefined` rather than an empty string: the process never produced a stream.
  assert.equal(missing.stdout ?? '', '');
});
