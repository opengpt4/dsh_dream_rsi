import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActionGuard,
  ALLOWED_TOOL_PERMISSIONS,
  EMBODIED_ACTION_TYPES,
  InMemoryAuditLog,
  MOCK_CAPABILITY_PROFILE,
  narrowCapabilityProfile,
  MOCK_ENVIRONMENT_ID,
  MockEmbodiedBackend,
  MockEnvironmentAdapter,
  RATE_WINDOW_MS,
  canTransition,
  checkCapability,
  createDreamRsiRuntime,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runEpisode,
  runEpisodePipeline,
  terminalStateFor,
  transition,
  verifyReadiness
} from '../dist/index.js';

const SESSION_ID = 'session-1';
const FRAME_ID = 'mock-room-v1/world';

function guardRequest(overrides = {}) {
  const actionId = overrides.actionId ?? 'action-1';
  return {
    actionId,
    idempotencyKey: actionId,
    sessionId: SESSION_ID,
    taskId: 'task-1',
    episodeId: 'episode-1',
    correlationId: 'episode-1',
    actionType: 'move_relative',
    parameters: { dx: 1, dy: 0, dz: 0 },
    frameId: FRAME_ID,
    timeoutMs: 1_000,
    requestedAt: new Date().toISOString(),
    ...overrides
  };
}

function actionResult(overrides = {}) {
  return {
    actionId: 'action-1',
    status: 'completed',
    step: 1,
    pose: { x: 1, y: 0, z: 0, yaw: 0 },
    gripper: 'open',
    message: 'ok',
    execTimeMs: 1,
    completedAt: new Date().toISOString(),
    ...overrides
  };
}

function makeGuard(overrides = {}) {
  return new ActionGuard({
    profile: MOCK_CAPABILITY_PROFILE,
    actionLeaseMs: 30_000,
    maxActionsPerMinute: 30,
    requireConfirmation: true,
    ...overrides
  });
}

/** Resolves only when the signal aborts, so a deadline or stop must end it. */
const untilAborted = (status) => (signal) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(actionResult({ status })), { once: true });
  });

/**
 * Rejects when the signal aborts, which the adapter contract forbids: an
 * aborted call must resolve to a terminal result. This is the adapter-is-
 * unusable case the guard records rather than trusts.
 */
const throwingOnAbort = () => (signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('backend rejected the aborted call')), { once: true });
  });

test('the MVP action vocabulary has no representation for raw motor or joint control', () => {
  // The allowlist is closed: only high-level primitives exist, so there is no
  // value a candidate could name to reach joint velocity or a motor channel.
  assert.deepEqual(EMBODIED_ACTION_TYPES, ['move_relative', 'goto', 'pick', 'place', 'open']);
  for (const forbidden of ['joint_velocity', 'set_joint', 'raw_motor', 'torque', 'motor_command']) {
    assert.ok(!EMBODIED_ACTION_TYPES.includes(forbidden), forbidden);
  }
  // Tool permissions are derived from the same list, so they cannot exceed it.
  assert.deepEqual(
    [...ALLOWED_TOOL_PERMISSIONS],
    EMBODIED_ACTION_TYPES.map((action) => `action:${action}`)
  );
  for (const action of Object.keys(MOCK_CAPABILITY_PROFILE.actions)) {
    assert.ok(EMBODIED_ACTION_TYPES.includes(action), action);
  }
});

test('a forged capability profile cannot widen the action vocabulary', () => {
  const forged = {
    profileId: 'forged',
    sensors: [],
    coordinateFrames: [FRAME_ID],
    actions: {
      joint_velocity: {
        actionType: 'joint_velocity',
        risk: 'high',
        requiresConfirmation: false,
        limits: { allowedParameters: ['radians'], maxNumericMagnitude: 100, maxDurationMs: 1_000 }
      }
    }
  };

  const result = checkCapability(forged, {
    actionType: 'joint_velocity',
    frameId: FRAME_ID,
    parameters: { radians: 1 },
    timeoutMs: 100
  });

  assert.equal(result.allowed, false);
  assert.equal(result.rejection.code, 'action_not_declared');
  assert.match(result.rejection.reason, /not part of the MVP action vocabulary/);
});

test('the guard refuses an action outside the vocabulary even when a profile declares it', async () => {
  const forged = {
    profileId: 'forged',
    sensors: [],
    coordinateFrames: [FRAME_ID],
    actions: {
      raw_motor: {
        actionType: 'raw_motor',
        risk: 'high',
        requiresConfirmation: false,
        limits: { allowedParameters: ['power'], maxNumericMagnitude: 100, maxDurationMs: 1_000 }
      }
    }
  };
  const guard = new ActionGuard({
    profile: forged,
    actionLeaseMs: 30_000,
    maxActionsPerMinute: 30,
    requireConfirmation: false
  });

  const record = await guard.execute(
    guardRequest({ actionType: 'raw_motor', parameters: { power: 1 } }),
    async () => actionResult()
  );

  assert.equal(record.state, 'FAILED');
  assert.equal(record.rejection.code, 'action_not_declared');
});

test('the state machine permits exactly the transitions in the design spec', () => {
  assert.equal(transition('REQUESTED', 'AUTHORIZED'), 'AUTHORIZED');
  assert.equal(transition('REQUESTED', 'FAILED'), 'FAILED');
  assert.equal(transition('AUTHORIZED', 'EXECUTING'), 'EXECUTING');
  assert.equal(transition('AUTHORIZED', 'CANCELLED'), 'CANCELLED');

  for (const terminal of ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'EMERGENCY_STOP']) {
    assert.equal(canTransition('EXECUTING', terminal), true, `EXECUTING -> ${terminal}`);
  }
  // Nothing skips AUTHORIZED or EXECUTING on the way to success.
  assert.equal(canTransition('REQUESTED', 'EXECUTING'), false);
  assert.equal(canTransition('REQUESTED', 'COMPLETED'), false);
});

test('terminal action states absorb every further transition', () => {
  // Terminality is exactly "absorbs every transition", so canTransition is the
  // whole test; nothing needs a separate predicate.
  for (const terminal of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'EMERGENCY_STOP']) {
    for (const next of ['REQUESTED', 'AUTHORIZED', 'EXECUTING', 'COMPLETED']) {
      assert.equal(canTransition(terminal, next), false, `${terminal} -> ${next}`);
    }
    assert.throws(() => transition(terminal, 'EXECUTING'), /illegal action transition/);
  }
  assert.equal(canTransition('EXECUTING', 'COMPLETED'), true);
  assert.equal(terminalStateFor('emergency_stop'), 'EMERGENCY_STOP');
});

test('capability check denies anything the profile does not declare', () => {
  const query = { actionType: 'move_relative', frameId: FRAME_ID, parameters: { dx: 1 }, timeoutMs: 1_000 };
  assert.equal(checkCapability(MOCK_CAPABILITY_PROFILE, query).allowed, true);

  const undeclaredAction = checkCapability(MOCK_CAPABILITY_PROFILE, { ...query, actionType: 'teleport' });
  assert.equal(undeclaredAction.rejection.code, 'action_not_declared');

  const undeclaredFrame = checkCapability(MOCK_CAPABILITY_PROFILE, { ...query, frameId: 'some/other-frame' });
  assert.equal(undeclaredFrame.rejection.code, 'frame_not_declared');

  const undeclaredParameter = checkCapability(MOCK_CAPABILITY_PROFILE, { ...query, parameters: { dx: 1, spin: 2 } });
  assert.equal(undeclaredParameter.rejection.code, 'parameter_not_allowed');

  const overLimit = checkCapability(MOCK_CAPABILITY_PROFILE, { ...query, parameters: { dx: 50 } });
  assert.equal(overLimit.rejection.code, 'limit_exceeded');

  const tooLong = checkCapability(MOCK_CAPABILITY_PROFILE, { ...query, timeoutMs: 600_000 });
  assert.equal(tooLong.rejection.code, 'duration_exceeded');
});

test('an authorized action walks REQUESTED -> AUTHORIZED -> EXECUTING -> COMPLETED', async () => {
  const guard = makeGuard();
  const record = await guard.execute(guardRequest(), async () => actionResult());

  assert.equal(record.state, 'COMPLETED');
  assert.deepEqual(record.history, ['REQUESTED', 'AUTHORIZED', 'EXECUTING', 'COMPLETED']);
  assert.equal(record.result.status, 'completed');
  assert.equal(record.rejection, undefined);
  assert.equal(guard.record('action-1').state, 'COMPLETED');
});

test('a rejected action never leaves REQUESTED', async () => {
  const guard = makeGuard();
  let ran = false;
  const record = await guard.execute(
    guardRequest({ actionType: 'teleport' }),
    async () => {
      ran = true;
      return actionResult();
    }
  );

  assert.equal(record.state, 'FAILED');
  assert.deepEqual(record.history, ['REQUESTED', 'FAILED']);
  assert.equal(record.rejection.code, 'action_not_declared');
  assert.equal(ran, false, 'the backend must not be reached');
  // A safety rejection is not cached: the next attempt is evaluated afresh.
  assert.deepEqual(guard.list(), []);
});

test('a second action on a busy session is refused rather than queued', async () => {
  const guard = makeGuard();
  let release;
  const blocking = new Promise((resolve) => {
    release = () => resolve(actionResult());
  });

  const first = guard.execute(guardRequest(), () => blocking);
  const second = await guard.execute(
    guardRequest({ actionId: 'action-2' }),
    async () => actionResult({ actionId: 'action-2' })
  );

  assert.equal(second.rejection.code, 'session_busy');
  release();
  assert.equal((await first).state, 'COMPLETED');

  // The slot is released, so the next action is admitted.
  const third = await guard.execute(
    guardRequest({ actionId: 'action-3' }),
    async () => actionResult({ actionId: 'action-3' })
  );
  assert.equal(third.state, 'COMPLETED');
});

test('the per-session rate limit holds until the window slides', async () => {
  let clock = 0;
  const guard = makeGuard({ maxActionsPerMinute: 2, now: () => clock });
  const run = async (id) => actionResult({ actionId: id });

  assert.equal((await guard.execute(guardRequest({ actionId: 'a1' }), () => run('a1'))).state, 'COMPLETED');
  assert.equal((await guard.execute(guardRequest({ actionId: 'a2' }), () => run('a2'))).state, 'COMPLETED');

  const limited = await guard.execute(guardRequest({ actionId: 'a3' }), () => run('a3'));
  assert.equal(limited.rejection.code, 'rate_limited');

  clock += RATE_WINDOW_MS;
  const afterWindow = await guard.execute(guardRequest({ actionId: 'a4' }), () => run('a4'));
  assert.equal(afterWindow.state, 'COMPLETED');
});

test('an idempotency key resolves to the recorded result without re-running the backend', async () => {
  const guard = makeGuard();
  let runs = 0;
  const run = async () => {
    runs += 1;
    return actionResult();
  };

  const first = await guard.execute(guardRequest(), run);
  const replay = await guard.execute(guardRequest(), run);

  assert.equal(runs, 1);
  assert.deepEqual(replay, first);
});

test('a high-risk action without confirmation is denied, and approval admits it', async () => {
  const request = guardRequest({ actionType: 'pick', parameters: { objectId: 'red-mug' } });

  const strict = makeGuard();
  const denied = await strict.execute(request, async () => actionResult({ actionType: 'pick' }));
  assert.equal(denied.rejection.code, 'confirmation_required');

  const noApproval = makeGuard({ confirm: () => false });
  const refused = await noApproval.execute(
    guardRequest({ actionType: 'pick', parameters: { objectId: 'red-mug' }, confirmationToken: 'token-1' }),
    async () => actionResult()
  );
  assert.equal(refused.rejection.code, 'confirmation_denied');

  const approving = makeGuard({ confirm: (candidate) => candidate.token === 'token-1' });
  const admitted = await approving.execute(
    guardRequest({ actionType: 'pick', parameters: { objectId: 'red-mug' }, confirmationToken: 'token-1' }),
    async () => actionResult()
  );
  assert.equal(admitted.state, 'COMPLETED');
});

test('confirmation is not demanded when the host does not require it', async () => {
  const guard = makeGuard({ requireConfirmation: false });
  const record = await guard.execute(
    guardRequest({ actionType: 'pick', parameters: { objectId: 'red-mug' } }),
    async () => actionResult()
  );

  assert.equal(record.state, 'COMPLETED');
});

test('an emergency stop ends the action in flight and latches the session', async () => {
  const guard = makeGuard();
  const pending = guard.execute(guardRequest(), untilAborted('cancelled'));

  guard.emergencyStop(SESSION_ID, 'operator pressed stop');
  const record = await pending;

  assert.equal(record.state, 'EMERGENCY_STOP');
  assert.deepEqual(record.history, ['REQUESTED', 'AUTHORIZED', 'EXECUTING', 'EMERGENCY_STOP']);
  // The backend reported cancellation; the guard owns the reason, so it wins.
  assert.equal(record.result.status, 'emergency_stop');
  assert.equal(guard.isStopped(SESSION_ID), true);
});

test('no retry follows an emergency stop, including for a recorded idempotency key', async () => {
  const guard = makeGuard();
  await guard.execute(guardRequest(), async () => actionResult());
  guard.emergencyStop(SESSION_ID, 'operator pressed stop');

  let ran = false;
  const refused = await guard.execute(guardRequest(), async () => {
    ran = true;
    return actionResult();
  });

  // Same idempotency key as the completed action, yet the latch wins.
  assert.equal(refused.rejection.code, 'session_stopped');
  assert.equal(ran, false);

  guard.releaseSession(SESSION_ID);
  const rearmed = await guard.execute(
    guardRequest({ actionId: 'action-2' }),
    async () => actionResult({ actionId: 'action-2' })
  );
  assert.equal(rearmed.state, 'COMPLETED');
});

test('an action exceeding its lease terminates as TIMEOUT', async () => {
  const guard = makeGuard({ actionLeaseMs: 20 });
  const record = await guard.execute(guardRequest(), untilAborted('cancelled'));

  assert.equal(record.state, 'TIMEOUT');
  assert.match(record.result.error, /exceeded its 20ms lease/);
});

test('a backend that rejects its promise is recorded as a backend error', async () => {
  const guard = makeGuard();
  const record = await guard.execute(guardRequest(), async () => {
    throw new Error('adapter unusable');
  });

  assert.equal(record.state, 'FAILED');
  assert.equal(record.rejection.code, 'backend_error');
  assert.match(record.rejection.reason, /adapter unusable/);
  // The session slot is released, so the failure does not wedge the session.
  assert.equal(
    (await guard.execute(guardRequest({ actionId: 'action-2' }), async () => actionResult())).state,
    'COMPLETED'
  );
});

test('a lease expiry the backend rejects instead of resolving is a backend error', async () => {
  const guard = makeGuard({ actionLeaseMs: 20 });
  const record = await guard.execute(guardRequest(), throwingOnAbort());

  // The guard's lease fired, but the backend never resolved with an outcome, so
  // there is nothing for the guard's precedence to override: the adapter is
  // unusable and TIMEOUT is not claimed on its behalf.
  assert.equal(record.state, 'FAILED');
  assert.equal(record.result, undefined);
  assert.equal(record.rejection.code, 'backend_error');
  assert.match(record.rejection.reason, /rejected the aborted call/);
});

test('a stop during a call the backend rejects still latches, audits, and forbids retry', async () => {
  const audit = new InMemoryAuditLog();
  const guard = makeGuard({ audit, actionLeaseMs: 30_000 });
  const pending = guard.execute(guardRequest(), throwingOnAbort());

  guard.emergencyStop(SESSION_ID, 'operator pressed stop');
  const record = await pending;

  // The recorded outcome is the backend's failure, not the guard's stop — the
  // adapter contract makes a rejection mean unusable. The stop is still the
  // operator's, and that is what has to hold.
  assert.equal(record.state, 'FAILED');
  assert.equal(record.result, undefined);
  assert.equal(guard.isStopped(SESSION_ID), true);
  assert.deepEqual(audit.types(), ['action.emergency-stop']);

  let ran = false;
  const refused = await guard.execute(guardRequest({ actionId: 'action-2' }), async () => {
    ran = true;
    return actionResult();
  });
  assert.equal(refused.rejection.code, 'session_stopped');
  assert.equal(ran, false);
});

test('a stop marker left by a failed call does not relabel a later action', async () => {
  // The stop/lease precedence reads markers keyed by action id. A call the
  // backend rejected after a stop must not leave its marker behind: re-arming
  // the session and reusing the id would otherwise report a completed action as
  // an emergency stop that never happened.
  const guard = makeGuard();
  const pending = guard.execute(guardRequest(), throwingOnAbort());

  guard.emergencyStop(SESSION_ID, 'operator pressed stop');
  await pending;

  guard.releaseSession(SESSION_ID);
  const reused = await guard.execute(
    guardRequest({ idempotencyKey: 'action-1-again' }),
    async () => actionResult()
  );

  assert.equal(reused.state, 'COMPLETED');
  assert.equal(reused.result.status, 'completed');
});

test('an episode dispatched through the guard records one node per authorized action', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const result = await runEpisodePipeline({
      task: {
        taskId: 'task-1',
        goal: 'reach x=2',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'policy-v1',
        budget: { maxSteps: 5, wallClockMs: 60_000 },
        metadata: {}
      },
      episodeId: 'episode-1',
      sessionId: SESSION_ID,
      adapter: runtime.adapter,
      store: runtime.store,
      guard: runtime.guard,
      policy: planPolicy([
        { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } },
        { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }
      ]),
      isGoalReached: (observation) => observation.pose.x >= 2,
      settings: pipelineSettings(runtime)
    });

    assert.equal(result.outcome.episode.status, 'completed');
    assert.deepEqual(
      runtime.guard.list().map((record) => record.state),
      ['COMPLETED', 'COMPLETED']
    );
    assert.deepEqual(runtime.guard.list()[0].history, ['REQUESTED', 'AUTHORIZED', 'EXECUTING', 'COMPLETED']);
  } finally {
    runtime.dispose();
  }
});

test('the guard blocks an out-of-limit action inside an episode and fails it', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const { episode, nodes, cause } = await runEpisode({
      task: {
        taskId: 'task-1',
        goal: 'overshoot',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'policy-v1',
        budget: { maxSteps: 5, wallClockMs: 60_000 },
        metadata: {}
      },
      episodeId: 'episode-1',
      sessionId: SESSION_ID,
      adapter: runtime.adapter,
      store: runtime.store,
      guard: runtime.guard,
      policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 50, dy: 0, dz: 0 } }]),
      isGoalReached: () => false
    });

    assert.equal(episode.status, 'failed');
    assert.match(cause, /limit_exceeded/);
    // The rejection is still a recorded step, with the observation it came from.
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].result.status, 'failed');
    assert.equal(nodes[0].episodeId, 'episode-1');
    assert.equal(nodes[0].actionType, 'move_relative');
  } finally {
    runtime.dispose();
  }
});

test('an episode ending in an emergency stop latches the guard for the session', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const stop = new AbortController();
    const adapter = new MockEnvironmentAdapter(new MockEmbodiedBackend());

    const { episode } = await runEpisode({
      task: {
        taskId: 'task-1',
        goal: 'never reached',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'policy-v1',
        budget: { maxSteps: 5, wallClockMs: 60_000 },
        metadata: {}
      },
      episodeId: 'episode-1',
      sessionId: SESSION_ID,
      adapter,
      store: runtime.store,
      guard: runtime.guard,
      emergencyStop: stop.signal,
      isGoalReached: () => false,
      policy: ({ step }) => {
        if (step === 1) stop.abort();
        return { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } };
      }
    });

    assert.equal(episode.status, 'emergency_stop');
    assert.equal(runtime.guard.isStopped(SESSION_ID), true);

    const refused = await runtime.guard.execute(
      guardRequest({ actionId: 'after-stop' }),
      async () => actionResult()
    );
    assert.equal(refused.rejection.code, 'session_stopped');
  } finally {
    runtime.dispose();
  }
});

// ------------------------------------------------- narrowing by configuration

test('configuration can narrow the action set but never widen it', () => {
  const narrowed = narrowCapabilityProfile(MOCK_CAPABILITY_PROFILE, ['move_relative', 'goto']);

  assert.deepEqual(Object.keys(narrowed.actions).sort(), ['goto', 'move_relative']);
  // Everything else about the declaration is untouched.
  assert.equal(narrowed.profileId, MOCK_CAPABILITY_PROFILE.profileId);
  assert.deepEqual(narrowed.sensors, MOCK_CAPABILITY_PROFILE.sensors);

  // An action the backend never declared cannot be granted by configuration.
  assert.throws(
    () => narrowCapabilityProfile(MOCK_CAPABILITY_PROFILE, ['teleport']),
    /cannot allow action\(s\) the profile does not declare: teleport/
  );
  // Narrowing to nothing would leave a backend that cannot act.
  assert.throws(
    () => narrowCapabilityProfile(MOCK_CAPABILITY_PROFILE, []),
    /would leave the backend unable to act/
  );
});

test('the runtime narrows to what configuration allows', async () => {
  const runtime = createDreamRsiRuntime(
    resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' }, embodied: { allowActions: ['move_relative'] } })
  );
  try {
    assert.deepEqual(Object.keys(runtime.capabilityProfile.actions), ['move_relative']);
    // The adapter still declares the full profile; the runtime holds the effective one.
    assert.deepEqual(Object.keys(runtime.adapter.capability().actions).sort(), ['goto', 'move_relative', 'open', 'pick', 'place']);

    const allowed = await runtime.guard.execute(
      guardRequest({ actionId: 'a1', actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }),
      async () => actionResult()
    );
    assert.equal(allowed.state, 'COMPLETED');

    // A declared action that configuration removed is denied, and the denial
    // names the profile rather than the vocabulary.
    const refused = await runtime.guard.execute(
      guardRequest({ actionId: 'a2', actionType: 'pick', parameters: { objectId: 'red-mug' }, confirmationToken: 't' }),
      async () => actionResult()
    );
    assert.equal(refused.state, 'FAILED');
    assert.equal(refused.rejection.code, 'action_not_declared');
    assert.match(refused.rejection.reason, /is not declared by/);
  } finally {
    runtime.dispose();
  }
});

test('configuration that names an unknown action is refused at load', () => {
  assert.throws(
    () => resolveDreamRsiConfig({ embodied: { allowActions: ['move_relative', 'teleport'] } }),
    /allowActions names teleport, which is not part of the MVP action vocabulary/
  );
  assert.throws(
    () => resolveDreamRsiConfig({ embodied: { allowActions: [] } }),
    /allowActions must not be empty; disable embodied instead/
  );
  // The default is the whole declared set.
  assert.deepEqual(resolveDreamRsiConfig({}).embodied.allowActions, [
    'move_relative',
    'goto',
    'pick',
    'place',
    'open'
  ]);
});

test('readiness reports the effective profile rather than the declared one', () => {
  const runtime = createDreamRsiRuntime(
    resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' }, embodied: { allowActions: ['goto'] } })
  );
  try {
    const report = verifyReadiness({ runtime });
    const check = report.checks.find((entry) => entry.name === 'capabilityProfile');
    assert.equal(check.state, 'ready');
    // One action, so the narrowing is visible in the report.
    assert.match(check.detail, /^1 actions across 1 frame\(s\)/);
  } finally {
    runtime.dispose();
  }
});
