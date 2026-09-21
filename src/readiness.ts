import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EMBODIED_ACTION_TYPES } from './embodied/protocol.js';
import type { PolicyRegistry } from './registry/policy-registry.js';
import type { DreamRsiRuntime } from './runtime.js';

/**
 * Readiness verification, per DETAILED_DESIGN_SPEC section 4.2.
 *
 * `ready` verifies the storage schema, the current policy artifact, evaluator
 * worker availability, and the backend capability profile before anything is
 * allowed to depend on the runtime.
 */

export type ReadinessState = 'ready' | 'not-ready' | 'not-probed';

export interface ReadinessCheck {
  readonly name: string;
  readonly state: ReadinessState;
  readonly detail: string;
}

export interface ReadinessReport {
  /** True when no check failed. A `not-probed` check does not make this false. */
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
  readonly checkedAt: string;
}

export interface ReadinessInput {
  readonly runtime: DreamRsiRuntime;
  /** When supplied, the current-policy pointer is verified against it. */
  readonly registry?: PolicyRegistry;
  readonly evaluatorWorkerPath?: string;
  /**
   * Opening the store creates the database file and its directory. Readiness is
   * often called from a read-only surface, so probing is opt-in.
   */
  readonly probeStorage?: boolean;
  readonly now?: () => Date;
}

export function verifyReadiness(input: ReadinessInput): ReadinessReport {
  const checks: ReadinessCheck[] = [
    storageCheck(input),
    capabilityProfileCheck(input.runtime),
    evaluatorWorkerCheck(input.evaluatorWorkerPath)
  ];
  if (input.registry !== undefined) checks.push(currentPolicyCheck(input.registry));

  return {
    ready: checks.every((check) => check.state !== 'not-ready'),
    checks,
    checkedAt: (input.now?.() ?? new Date()).toISOString()
  };
}

function storageCheck(input: ReadinessInput): ReadinessCheck {
  if (input.probeStorage !== true) {
    return {
      name: 'storage',
      state: 'not-probed',
      detail: `storage at ${input.runtime.config.storage.sqlitePath} was not opened`
    };
  }
  try {
    input.runtime.store.readAll();
    return { name: 'storage', state: 'ready', detail: input.runtime.config.storage.sqlitePath };
  } catch (error) {
    return {
      name: 'storage',
      state: 'not-ready',
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * A capability profile that declares an action outside the MVP vocabulary would
 * be silently unusable; readiness catches it before an episode does.
 */
function capabilityProfileCheck(runtime: DreamRsiRuntime): ReadinessCheck {
  const profile = runtime.adapter.capability();
  const actions = Object.keys(profile.actions);
  if (actions.length === 0) {
    return { name: 'capabilityProfile', state: 'not-ready', detail: 'the profile declares no actions' };
  }
  const undeclared = actions.filter(
    (action) => !(EMBODIED_ACTION_TYPES as readonly string[]).includes(action)
  );
  if (undeclared.length > 0) {
    return {
      name: 'capabilityProfile',
      state: 'not-ready',
      detail: `the profile declares actions outside the MVP vocabulary: ${undeclared.join(', ')}`
    };
  }
  // Without a frame, an observation's pose cannot be interpreted, and the
  // perceive tool would have nothing to report.
  const frame = runtime.adapter.capability().coordinateFrames[0];
  if (frame === undefined) {
    return { name: 'capabilityProfile', state: 'not-ready', detail: 'the profile declares no coordinate frame' };
  }
  return {
    name: 'capabilityProfile',
    state: 'ready',
    detail: `${actions.length} actions across ${profile.coordinateFrames.length} frame(s)`
  };
}

function evaluatorWorkerCheck(workerPath: string | undefined): ReadinessCheck {
  const path = workerPath ?? fileURLToPath(new URL('./evolution/evaluator-worker.js', import.meta.url));
  return existsSync(path)
    ? { name: 'evaluatorWorker', state: 'ready', detail: path }
    : { name: 'evaluatorWorker', state: 'not-ready', detail: `${path} does not exist` };
}

function currentPolicyCheck(registry: PolicyRegistry): ReadinessCheck {
  const current = registry.currentPolicyArtifactId();
  // No current policy is the initial state, not a fault: nothing has deployed.
  if (current === null) {
    return { name: 'currentPolicy', state: 'ready', detail: 'no policy has been deployed yet' };
  }
  const artifact = registry.policy(current);
  if (artifact === undefined) {
    return {
      name: 'currentPolicy',
      state: 'not-ready',
      detail: `the current pointer names unregistered artifact ${current}`
    };
  }
  return { name: 'currentPolicy', state: 'ready', detail: `v${artifact.version} (${artifact.artifactId.slice(0, 12)})` };
}
