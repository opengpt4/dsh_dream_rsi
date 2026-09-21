import { EMBODIED_ACTION_TYPES } from '../embodied/protocol.js';
import type { ActionCapability, CapabilityProfile } from '../embodied/capability.js';

/**
 * Capability enforcement.
 *
 * The profile a backend declares lives in the environment layer; this module
 * checks a request against it. A capability absent from the profile is denied,
 * never defaulted.
 */

export {
  MOCK_CAPABILITY_PROFILE,
  type ActionCapability,
  type ActionLimits,
  type CapabilityProfile,
  type RiskLevel
} from '../embodied/capability.js';

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
  readonly actionType: string;
  readonly frameId: string;
  readonly parameters: Record<string, unknown>;
  readonly timeoutMs: number;
}

export function checkCapability(profile: CapabilityProfile, query: CapabilityQuery): CapabilityCheck {
  // The allowlist is closed against the declared vocabulary, so a forged profile
  // cannot widen it by naming an action the MVP does not have — raw motor and
  // joint control in particular.
  if (!(EMBODIED_ACTION_TYPES as readonly string[]).includes(query.actionType)) {
    return deny('action_not_declared', `action ${query.actionType} is not part of the MVP action vocabulary`);
  }

  const capability = profile.actions[query.actionType as keyof CapabilityProfile['actions']];
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
