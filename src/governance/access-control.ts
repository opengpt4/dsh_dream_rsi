/**
 * Access control for the governed operations.
 *
 * Deny by default: a principal with no matching role is refused, and an action
 * absent from the policy is refused rather than assumed permitted.
 */

export type GovernedAction =
  | 'evolve'
  | 'approve'
  | 'deploy'
  | 'rollback'
  | 'approve-tool'
  | 'emergency-stop';

export const GOVERNED_ACTIONS: readonly GovernedAction[] = [
  'evolve',
  'approve',
  'deploy',
  'rollback',
  'approve-tool',
  'emergency-stop'
];

export type Role = 'viewer' | 'operator' | 'approver' | 'admin';

export interface Principal {
  readonly principalId: string;
  readonly roles: readonly Role[];
}

export interface AccessPolicy {
  readonly grants: Readonly<Partial<Record<GovernedAction, readonly Role[]>>>;
  /** Break-glass role that is granted every action. */
  readonly superuserRole: Role;
}

export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  superuserRole: 'admin',
  grants: {
    evolve: ['operator', 'admin'],
    // Approval and deployment are separate grants: the person who proposes a
    // candidate is not automatically the person who may put it live.
    approve: ['approver', 'admin'],
    deploy: ['approver', 'admin'],
    rollback: ['operator', 'approver', 'admin'],
    'approve-tool': ['approver', 'admin'],
    'emergency-stop': ['operator', 'approver', 'admin']
  }
};

export type AccessDecision =
  | { readonly allowed: true; readonly action: GovernedAction; readonly principalId: string }
  | {
      readonly allowed: false;
      readonly action: GovernedAction;
      readonly principalId: string;
      readonly reason: string;
    };

export function checkAccess(
  policy: AccessPolicy,
  principal: Principal,
  action: GovernedAction
): AccessDecision {
  if (principal.principalId.trim().length === 0) {
    return { allowed: false, action, principalId: principal.principalId, reason: 'principal has no identity' };
  }
  if (principal.roles.includes(policy.superuserRole)) {
    return { allowed: true, action, principalId: principal.principalId };
  }

  const granted = policy.grants[action];
  if (granted === undefined) {
    return { allowed: false, action, principalId: principal.principalId, reason: `no policy entry for ${action}` };
  }
  if (!granted.some((role) => principal.roles.includes(role))) {
    return {
      allowed: false,
      action,
      principalId: principal.principalId,
      reason: `${principal.principalId} holds none of ${granted.join(', ')} required for ${action}`
    };
  }
  return { allowed: true, action, principalId: principal.principalId };
}

export function assertAccess(policy: AccessPolicy, principal: Principal, action: GovernedAction): void {
  const decision = checkAccess(policy, principal, action);
  if (!decision.allowed) throw new Error(`access denied for ${action}: ${decision.reason}`);
}
