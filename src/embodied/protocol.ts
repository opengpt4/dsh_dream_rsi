import type { JsonObject } from '../discovery/models.js';

/**
 * Environment-facing contract shared by every adapter.
 *
 * Core policy code sees these types and nothing else: the simulator SDK, motor
 * channels, and transport details stay behind {@link EnvironmentAdapter}.
 */

/** Pose schema version. Bump when a field changes meaning, not when one is added. */
export const OBSERVATION_SCHEMA_VERSION = 1;

export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export type GripperState = 'open' | 'closed';

export type EmbodiedActionType = 'move_relative' | 'goto' | 'pick' | 'place' | 'open';

export const EMBODIED_ACTION_TYPES: readonly EmbodiedActionType[] = [
  'move_relative',
  'goto',
  'pick',
  'place',
  'open'
];

export interface ObservedObject {
  readonly id: string;
  readonly label: string;
  readonly position: readonly [number, number, number];
}

export interface Observation {
  readonly sessionId: string;
  readonly environmentId: string;
  readonly environmentVersion: string;
  /** Coordinate frame every position and pose in this observation is expressed in. */
  readonly frameId: string;
  readonly step: number;
  readonly pose: Pose;
  readonly gripper: GripperState;
  readonly objects: readonly ObservedObject[];
  readonly schemaVersion: number;
  readonly timestamp: string;
}

export interface ObserveRequest {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly includeObjects: boolean;
}

/**
 * Terminal outcome of one action attempt.
 *
 * `EMERGENCY_STOP` is not interchangeable with `CANCELLED`: an operator stop
 * forbids automatic retry, a cancellation does not.
 */
export type ActionStatus = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'emergency_stop';

export interface ActionRequest {
  /** Stable for the life of this attempt, so every terminal record carries it. */
  readonly actionId: string;
  readonly sessionId: string;
  /** Absent for an interactive action taken through a tool rather than an episode. */
  readonly taskId?: string;
  readonly episodeId?: string;
  readonly correlationId: string;
  readonly actionType: EmbodiedActionType;
  readonly parameters: JsonObject;
  readonly timeoutMs: number;
  readonly requestedAt: string;
}

export interface ActionResult {
  readonly actionId: string;
  readonly status: ActionStatus;
  readonly step: number;
  readonly pose: Pose;
  readonly gripper: GripperState;
  readonly message: string;
  readonly execTimeMs: number;
  readonly completedAt: string;
  readonly error?: string;
}

export interface EnvironmentAdapter {
  observe(request: ObserveRequest): Promise<Observation>;
  availableActions(): Promise<readonly EmbodiedActionType[]>;
  /**
   * Resolve to a terminal {@link ActionResult} rather than throw: a failed,
   * timed-out, or stopped action is a recorded outcome, not an exception.
   * Rejects only when the adapter itself is unusable.
   */
  execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult>;
  emergencyStop(sessionId: string): Promise<void>;
  reset(sessionId: string): void;
}
