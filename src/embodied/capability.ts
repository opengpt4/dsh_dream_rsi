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

/**
 * Restrict a declared profile to an allowed subset of actions.
 *
 * Narrowing only: an action the profile never declared cannot be added by
 * configuration, so config can tighten a deployment but never widen it. An
 * empty result is refused rather than producing a backend that can do nothing.
 */
export function narrowCapabilityProfile(
  profile: CapabilityProfile,
  allowedActions: readonly string[]
): CapabilityProfile {
  const undeclared = allowedActions.filter((action) => profile.actions[action as keyof CapabilityProfile['actions']] === undefined);
  if (undeclared.length > 0) {
    throw new Error(
      `cannot allow action(s) the profile does not declare: ${undeclared.join(', ')}; declared actions are ${Object.keys(profile.actions).join(', ')}`
    );
  }
  const actions: Record<string, ActionCapability> = {};
  for (const action of allowedActions) {
    actions[action] = profile.actions[action as keyof CapabilityProfile['actions']]!;
  }
  if (Object.keys(actions).length === 0) {
    throw new Error('narrowing to no actions would leave the backend unable to act; disable embodied instead');
  }
  return { ...profile, actions: actions as CapabilityProfile['actions'] };
}
