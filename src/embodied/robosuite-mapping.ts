import type { JsonObject } from '../discovery/models.js';
import { OBSERVATION_SCHEMA_VERSION, type ActionResult, type ActionStatus, type Observation, type Pose } from './protocol.js';
import type { EmbodiedActionType } from './protocol.js';

/**
 * Mapping between the bridge's raw simulator state and the plugin's data model.
 *
 * Kept apart from the adapter that spawns the bridge, and pure, for two reasons:
 * the mapping is the part worth testing exhaustively, and the child's reply is
 * untrusted input — it crosses a process boundary and is parsed from JSON — so
 * it is validated and rebuilt field by field rather than cast, the same rule the
 * isolated evaluator applies to its worker.
 */

/** The frame every position in a RoboSuite observation is expressed in. */
export const ROBOSUITE_FRAME_ID = 'mujoco-world';

export interface BridgeState {
  readonly step: number;
  readonly pose: Pose;
  readonly gripper: 'open' | 'closed';
  readonly objects: Readonly<Record<string, readonly number[]>>;
  readonly status?: string;
}

export interface ObservationIdentity {
  readonly sessionId: string;
  readonly environmentId: string;
  readonly environmentVersion: string;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`bridge state ${what} is not a finite number: ${String(value)}`);
  }
  return value;
}

/**
 * Validate the child's state and rebuild it as the plugin's own record.
 *
 * A missing or malformed field is refused rather than defaulted: a defaulted
 * pose would be recorded as an observation the environment never produced, and
 * every replay and score afterwards would rest on it.
 */
export function toObservation(
  identity: ObservationIdentity,
  state: BridgeState,
  timestamp: string
): Observation {
  if (state === null || typeof state !== 'object') {
    throw new Error('bridge state is not an object');
  }
  const pose = state.pose as Partial<Pose> | undefined;
  if (pose === null || typeof pose !== 'object') throw new Error('bridge state carries no pose');
  const objects = state.objects ?? {};
  if (typeof objects !== 'object') throw new Error('bridge state objects is not an object');
  if (state.gripper !== 'open' && state.gripper !== 'closed') {
    throw new Error(`bridge state gripper is neither open nor closed: ${String(state.gripper)}`);
  }

  const observed = Object.entries(objects).map(([id, position]) => {
    if (!Array.isArray(position) || position.length !== 3) {
      throw new Error(`bridge state object ${id} is not a three-number position`);
    }
    return {
      id,
      label: id,
      position: [finite(position[0], `${id}.x`), finite(position[1], `${id}.y`), finite(position[2], `${id}.z`)] as const
    };
  });

  return {
    sessionId: identity.sessionId,
    environmentId: identity.environmentId,
    environmentVersion: identity.environmentVersion,
    frameId: ROBOSUITE_FRAME_ID,
    step: finite(state.step, 'step'),
    pose: {
      x: finite(pose.x, 'pose.x'),
      y: finite(pose.y, 'pose.y'),
      z: finite(pose.z, 'pose.z'),
      yaw: finite(pose.yaw, 'pose.yaw')
    },
    gripper: state.gripper,
    objects: observed,
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    timestamp
  };
}

/** The control steps an action is allowed, by the vocabulary the plugin exposes. */
const ACTION_STEPS: Readonly<Record<EmbodiedActionType, number>> = {
  move_relative: 20,
  goto: 25,
  // A grasp and a release need the fingers to travel, so they hold longer.
  pick: 30,
  place: 30,
  open: 10
};

export interface BridgeRequest {
  readonly actionType: EmbodiedActionType;
  readonly parameters: JsonObject;
  readonly steps: number;
}

/**
 * Translate a plugin action into the bridge's request.
 *
 * The vocabulary is closed on both sides, so an action outside it is refused
 * here rather than sent and refused there: a caller learns at the boundary it
 * controls, and nothing reaches a live environment on a typo.
 */
export function toBridgeRequest(actionType: string, parameters: JsonObject): BridgeRequest {
  const steps = ACTION_STEPS[actionType as EmbodiedActionType];
  if (steps === undefined) {
    throw new Error(
      `unsupported action ${actionType}; this adapter implements ${Object.keys(ACTION_STEPS).join(', ')}`
    );
  }
  return { actionType: actionType as EmbodiedActionType, parameters, steps };
}

/** The terminal status the bridge reports, mapped onto the plugin's own. */
export function toActionStatus(reported: unknown): ActionStatus {
  if (reported === 'completed') return 'completed';
  if (reported === 'timeout') return 'timeout';
  if (reported === 'failed') return 'failed';
  // Anything else is not an outcome the bridge is allowed to invent, and an
  // unknown status must not read as success.
  throw new Error(`bridge reported an unknown action status: ${String(reported)}`);
}

export interface ActionResultInput {
  readonly actionId: string;
  readonly completedAt: string;
  readonly execTimeMs: number;
  readonly message: string;
}

export function toActionResult(state: BridgeState, input: ActionResultInput): ActionResult {
  return {
    actionId: input.actionId,
    status: toActionStatus(state.status),
    step: finite(state.step, 'step'),
    pose: {
      x: finite(state.pose?.x, 'pose.x'),
      y: finite(state.pose?.y, 'pose.y'),
      z: finite(state.pose?.z, 'pose.z'),
      yaw: finite(state.pose?.yaw, 'pose.yaw')
    },
    gripper: state.gripper,
    message: input.message,
    execTimeMs: input.execTimeMs,
    completedAt: input.completedAt
  };
}
