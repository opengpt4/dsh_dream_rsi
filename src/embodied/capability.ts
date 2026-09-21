import type { EmbodiedActionType } from './protocol.js';

/**
 * What an embodied backend declares it can sense and do.
 *
 * These types live in the environment layer, not the safety layer: a backend
 * declares its profile, and safety enforces it. Keeping the declaration here is
 * what lets `EnvironmentAdapter` expose `capability()` without depending on the
 * layer that checks it.
 */

export type RiskLevel = 'safe' | 'guarded' | 'high';

export interface ActionLimits {
  /** Parameter names this action accepts. An undeclared name is rejected. */
  readonly allowedParameters: readonly string[];
  /** Ceiling on the magnitude of any numeric parameter. */
  readonly maxNumericMagnitude: number;
  /** Ceiling on the deadline a caller may request. */
  readonly maxDurationMs: number;
}

export interface ActionCapability {
  readonly actionType: EmbodiedActionType;
  readonly risk: RiskLevel;
  /** High-risk actions need an explicit confirmation before authorization. */
  readonly requiresConfirmation: boolean;
  readonly limits: ActionLimits;
}

export interface CapabilityProfile {
  readonly profileId: string;
  /** Sensor identifiers the backend actually reports. */
  readonly sensors: readonly string[];
  /** Coordinate frames an observation or action may be expressed in. */
  readonly coordinateFrames: readonly string[];
  readonly actions: Readonly<Partial<Record<EmbodiedActionType, ActionCapability>>>;
}

export const MOCK_CAPABILITY_PROFILE: CapabilityProfile = {
  profileId: 'mock-room-v1/capabilities@1',
  sensors: ['pose', 'gripper', 'objects'],
  coordinateFrames: ['mock-room-v1/world'],
  actions: {
    move_relative: {
      actionType: 'move_relative',
      risk: 'safe',
      requiresConfirmation: false,
      limits: { allowedParameters: ['dx', 'dy', 'dz'], maxNumericMagnitude: 5, maxDurationMs: 30_000 }
    },
    goto: {
      actionType: 'goto',
      risk: 'guarded',
      requiresConfirmation: false,
      limits: { allowedParameters: ['x', 'y', 'z'], maxNumericMagnitude: 100, maxDurationMs: 30_000 }
    },
    pick: {
      actionType: 'pick',
      risk: 'guarded',
      requiresConfirmation: true,
      limits: { allowedParameters: ['objectId'], maxNumericMagnitude: 0, maxDurationMs: 30_000 }
    },
    place: {
      actionType: 'place',
      risk: 'guarded',
      requiresConfirmation: true,
      limits: { allowedParameters: ['x', 'y', 'z'], maxNumericMagnitude: 100, maxDurationMs: 30_000 }
    },
    open: {
      actionType: 'open',
      risk: 'safe',
      requiresConfirmation: false,
      limits: { allowedParameters: [], maxNumericMagnitude: 0, maxDurationMs: 30_000 }
    }
  }
};
