import type { DeploymentState } from './models.js';

/**
 * The deployment state machine from the design spec, as data.
 *
 * `ACTIVE -> ROLLED_BACK` is deliberately absent: an active deployment is
 * degraded first, so a rollback always records that degradation was observed
 * rather than jumping straight to the end state.
 */
const DEPLOYMENT_TRANSITIONS: Readonly<Record<DeploymentState, readonly DeploymentState[]>> = {
  PROPOSED: ['APPROVED', 'REJECTED'],
  APPROVED: ['CANARY', 'ROLLED_BACK'],
  CANARY: ['ACTIVE', 'ROLLED_BACK'],
  ACTIVE: ['DEGRADED'],
  DEGRADED: ['ROLLED_BACK'],
  REJECTED: [],
  ROLLED_BACK: []
};

export function canTransitionDeployment(from: DeploymentState, to: DeploymentState): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}

export function transitionDeployment(from: DeploymentState, to: DeploymentState): DeploymentState {
  if (!canTransitionDeployment(from, to)) throw new Error(`illegal deployment transition ${from} -> ${to}`);
  return to;
}

/** States from which a rollback is reachable in one step. */
export function isRollbackReachable(state: DeploymentState): boolean {
  return DEPLOYMENT_TRANSITIONS[state].includes('ROLLED_BACK');
}
