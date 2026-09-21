import type { JsonObject } from '../discovery/models.js';
import { EMBODIED_ACTION_TYPES, type EmbodiedActionType } from '../embodied/protocol.js';

/**
 * What an embodied backend declares it can do.
 *
 * A capability absent from the profile is denied, not defaulted: an undeclared
 * action, frame, sensor, or limit must never be invoked.
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

export type RejectionCode =
  | 'session_stopped'
  | 'action_not_declared'
  | 'frame_not_declared'
  | 'parameter_not_allowed'
  | 'limit_exceeded'
  | 'duration_exceeded'
  | 'confirmation_required'
  | 'confirmation_denied'
  | 'rate_limited'
  | 'session_busy'
  /** The backend rejected its promise; the adapter contract says that means it is unusable. */
  | 'backend_error';

export interface CapabilityRejection {
  readonly code: RejectionCode;
  readonly reason: string;
}

export type CapabilityCheck =
  | { readonly allowed: true; readonly capability: ActionCapability }
  | { readonly allowed: false; readonly rejection: CapabilityRejection };

export interface CapabilityQuery {
  readonly actionType: EmbodiedActionType;
  readonly frameId: string;
  readonly parameters: JsonObject;
  readonly timeoutMs: number;
}

export function checkCapability(profile: CapabilityProfile, query: CapabilityQuery): CapabilityCheck {
  // The allowlist is closed against the declared vocabulary, so a forged profile
  // cannot widen it by naming an action the MVP does not have — raw motor and
  // joint control in particular.
  if (!(EMBODIED_ACTION_TYPES as readonly string[]).includes(query.actionType)) {
    return deny('action_not_declared', `action ${query.actionType} is not part of the MVP action vocabulary`);
  }

  const capability = profile.actions[query.actionType];
  if (capability === undefined) {
    return deny('action_not_declared', `action ${query.actionType} is not declared by ${profile.profileId}`);
  }
  if (!profile.coordinateFrames.includes(query.frameId)) {
    return deny('frame_not_declared', `frame ${query.frameId} is not declared by ${profile.profileId}`);
  }

  const { allowedParameters, maxNumericMagnitude, maxDurationMs } = capability.limits;
  for (const [name, value] of Object.entries(query.parameters)) {
    if (!allowedParameters.includes(name)) {
      return deny('parameter_not_allowed', `parameter ${name} is not accepted by ${query.actionType}`);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return deny('limit_exceeded', `parameter ${name} must be finite`);
      if (Math.abs(value) > maxNumericMagnitude) {
        return deny(
          'limit_exceeded',
          `parameter ${name} of ${value} exceeds the ${query.actionType} limit of ${maxNumericMagnitude}`
        );
      }
    }
  }
  if (!Number.isFinite(query.timeoutMs) || query.timeoutMs <= 0) {
    return deny('duration_exceeded', `deadline ${query.timeoutMs}ms must be positive`);
  }
  if (query.timeoutMs > maxDurationMs) {
    return deny('duration_exceeded', `deadline ${query.timeoutMs}ms exceeds the ${query.actionType} limit of ${maxDurationMs}ms`);
  }

  return { allowed: true, capability };
}

function deny(code: RejectionCode, reason: string): CapabilityCheck {
  return { allowed: false, rejection: { code, reason } };
}

/**
 * The capability profile the mock backend declares. `pick` and `place` carry
 * confirmation because they act on an object rather than on the agent's own
 * pose.
 */
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
