import type { SingleWriterLock } from '../operations/single-writer-lock.js';
import { checkAccess, DEFAULT_ACCESS_POLICY, type AccessPolicy, type GovernedAction, type Principal } from '../governance/access-control.js';
import { isRollbackReachable, transitionDeployment } from './deployment-state.js';
import type { AuditEventType, AuditSink } from './audit.js';
import {
  advanceDeployment,
  sealDeployment,
  summarizeCanary,
  verifyPolicyArtifact,
  type Approval,
  type CanaryObservation,
  type CanaryResult,
  type CanaryThresholds,
  type Deployment,
  type DeploymentState,
  type HoldoutGateVerdict,
  type PolicyArtifact
} from './models.js';
import type { PolicyRegistry } from './policy-registry.js';

/**
 * The only component allowed to move a deployment between states.
 *
 * Every transition takes the deployment writer lease first, so two writers
 * cannot interleave a state machine. A transition that fails leaves the record
 * where it was, and the pointer moves only inside `registry.promotePolicy`,
 * which re-checks the evidence.
 */

/** Verifies a policy artifact's signature. Absent means nothing may be activated. */
export interface SignatureVerifier {
  verify(artifact: PolicyArtifact): boolean;
}

export interface DeploymentWriterOptions {
  readonly registry: PolicyRegistry;
  readonly lock: SingleWriterLock;
  readonly audit: AuditSink;
  /**
   * Required for activation. No verifier configured is a refusal, not a bypass:
   * an unsigned artifact must not reach production because nobody wired the check.
   */
  readonly signatureVerifier?: SignatureVerifier;
  /** Who this writer acts as. Every governed transition is checked against it. */
  readonly principal: Principal;
  /** Defaults to the deny-by-default policy. */
  readonly accessPolicy?: AccessPolicy;
  readonly now?: () => Date;
}

export interface ProposeDeploymentInput {
  readonly policyArtifactId: string;
  readonly evaluationId: string;
  readonly holdoutGate: HoldoutGateVerdict;
  readonly correlationId?: string;
}

export interface RollbackInput {
  readonly operator: string;
  readonly reason: string;
  readonly correlationId?: string;
}

export class DeploymentWriter {
  private readonly now: () => Date;
  private readonly accessPolicy: AccessPolicy;
  private sequence = 0;

  constructor(private readonly options: DeploymentWriterOptions) {
    this.now = options.now ?? (() => new Date());
    this.accessPolicy = options.accessPolicy ?? DEFAULT_ACCESS_POLICY;
  }

  /** PROPOSED. Records the baseline the gate evidence was taken against. */
  propose(input: ProposeDeploymentInput): Deployment {
    this.assertAllowed('evolve');
    return this.transition('policy.proposed', input.correlationId, () => {
      const { registry } = this.options;
      const artifact = registry.policy(input.policyArtifactId);
      if (artifact === undefined) throw new Error(`unknown policy artifact ${input.policyArtifactId}`);

      const report = registry.evaluation(input.evaluationId);
      if (report === undefined) throw new Error(`unknown evaluation ${input.evaluationId}`);
      if (report.policyArtifactId !== artifact.artifactId) {
        throw new Error(`evaluation ${report.evaluationId} does not cover policy ${artifact.artifactId}`);
      }
      if (!report.passed) throw new Error(`evaluation ${report.evaluationId} did not pass`);
      if (input.holdoutGate.candidateEvaluationId !== report.evaluationId) {
        throw new Error(`holdout gate does not cover evaluation ${report.evaluationId}`);
      }
      if (!input.holdoutGate.passed) throw new Error('holdout gate did not pass');

      const at = this.timestamp();
      const deployment = sealDeployment({
        deploymentId: this.nextDeploymentId(artifact.artifactId, report.evaluationId),
        policyArtifactId: artifact.artifactId,
        state: 'PROPOSED',
        history: ['PROPOSED'],
        evaluationId: report.evaluationId,
        holdoutGate: input.holdoutGate,
        approval: null,
        canary: null,
        // The baseline: what is live now is what the gate evidence was taken against.
        rollbackTarget: registry.currentPolicyArtifactId(),
        lockOwner: this.options.lock.owner,
        createdAt: at,
        updatedAt: at
      });
      this.options.registry.saveDeployment(deployment);
      return { deployment, policyArtifactId: artifact.artifactId, lockOwner: deployment.lockOwner ?? undefined };
    }).deployment;
  }

  /** PROPOSED -> APPROVED, or PROPOSED -> REJECTED. */
  decide(deploymentId: string, approval: Approval, correlationId?: string): Deployment {
    this.assertAllowed('approve');
    // Recording someone else's approval is not approval.
    if (approval.operator !== this.options.principal.principalId) {
      throw new Error(
        `approval names ${approval.operator} but this writer acts as ${this.options.principal.principalId}`
      );
    }
    const current = this.require(deploymentId);
    const to: DeploymentState = approval.decision === 'approved' ? 'APPROVED' : 'REJECTED';
    return this.advance(
      current,
      to,
      approval.decision === 'approved' ? 'policy.approved' : 'policy.rejected',
      correlationId,
      { approval, ...(approval.reason !== undefined ? { reason: approval.reason } : {}) },
      { operator: approval.operator }
    );
  }

  /** APPROVED -> CANARY. Verifies the artifact before any traffic reaches it. */
  startCanary(deploymentId: string, correlationId?: string): Deployment {
    this.assertAllowed('deploy');
    const current = this.require(deploymentId);
    return this.advance(current, 'CANARY', 'canary.started', correlationId, {}, {
      beforeAdvance: () => this.assertArtifactDeployable(current.policyArtifactId)
    });
  }

  /**
   * CANARY -> ACTIVE or CANARY -> ROLLED_BACK.
   *
   * Activation re-checks the baseline and delegates the pointer move to the
   * registry, which re-validates the gate, approval, and canary evidence.
   */
  completeCanary(
    deploymentId: string,
    observation: CanaryObservation,
    thresholds: CanaryThresholds,
    correlationId?: string
  ): Deployment {
    this.assertAllowed('deploy');
    const current = this.require(deploymentId);
    const canary = summarizeCanary(observation, thresholds, this.timestamp());

    if (!canary.passed) {
      return this.advance(current, 'ROLLED_BACK', 'canary.failed', correlationId, { canary }, {
        reason: `canary thresholds breached: ${canary.failures.join(', ')}`
      });
    }

    return this.transition('policy.deployed', correlationId, () => {
      this.assertBaselineUnchanged(current);
      this.assertArtifactDeployable(current.policyArtifactId);
      if (current.approval === null || current.evaluationId === null || current.holdoutGate === null) {
        throw new Error(`deployment ${deploymentId} cannot activate without an approval, an evaluation, and a gate verdict`);
      }
      const activated = this.options.registry.promotePolicy(current.policyArtifactId, {
        deploymentId: current.deploymentId,
        evaluationId: current.evaluationId,
        // The verdict recorded at propose time, not a fresh one: activation must
        // re-check the evidence that was actually reviewed.
        holdoutGate: current.holdoutGate,
        approval: current.approval,
        canary
      });
      // Resealed rather than spread: `lockOwner` is part of the hashed body, so
      // editing the record here without restamping it would leave a deployment
      // whose hash does not cover what it holds.
      const withOwner = sealDeployment({ ...activated, lockOwner: this.options.lock.owner });
      this.options.registry.saveDeployment(withOwner);
      return { deployment: withOwner, policyArtifactId: withOwner.policyArtifactId, lockOwner: withOwner.lockOwner ?? undefined };
    }).deployment;
  }

  /** ACTIVE -> DEGRADED. Rollback of an active deployment must pass through here. */
  markDegraded(deploymentId: string, reason: string, correlationId?: string): Deployment {
    return this.advance(this.require(deploymentId), 'DEGRADED', 'policy.degraded', correlationId, {}, { reason });
  }

  /**
   * Return to the previous stable artifact.
   *
   * An ACTIVE deployment degrades first, so the audit trail records that
   * degradation was observed rather than jumping to the end state.
   */
  rollback(deploymentId: string, input: RollbackInput): Deployment {
    this.assertAllowed('rollback');
    return this.transition('policy.rolled-back', input.correlationId, () => {
      let current = this.require(deploymentId);
      // ACTIVE is rollback-able, but only through DEGRADED, so it is not
      // `isRollbackReachable` on its own.
      if (current.state !== 'ACTIVE' && !isRollbackReachable(current.state)) {
        throw new Error(`deployment ${deploymentId} cannot be rolled back from ${current.state}`);
      }
      if (current.state === 'ACTIVE') {
        const at = this.timestamp();
        current = advanceDeployment(current, transitionDeployment('ACTIVE', 'DEGRADED'), { reason: input.reason }, at);
        this.options.registry.saveDeployment(current);
        // The degradation is its own audited fact, not a footnote on the
        // rollback: an operator reading the trail must see it was detected.
        this.options.audit.record({
          type: 'policy.degraded',
          subject: 'deployment',
          subjectId: current.deploymentId,
          policyArtifactId: current.policyArtifactId,
          correlationId: input.correlationId ?? current.deploymentId,
          operator: input.operator,
          reason: input.reason,
          lockOwner: this.options.lock.owner,
          at
        });
      }

      const at = this.timestamp();
      const rolledBack = advanceDeployment(
        current,
        transitionDeployment(current.state, 'ROLLED_BACK'),
        { reason: input.reason, lockOwner: this.options.lock.owner },
        at
      );
      this.options.registry.saveDeployment(rolledBack);

      if (rolledBack.rollbackTarget !== null) {
        this.options.registry.restoreCurrentPolicy(rolledBack.rollbackTarget);
      }
      return {
        deployment: rolledBack,
        policyArtifactId: rolledBack.policyArtifactId,
        operator: input.operator,
        reason: input.reason,
        lockOwner: rolledBack.lockOwner ?? undefined
      };
    }).deployment;
  }

  /** Refuses before any state is read or written, so a denial changes nothing. */
  private assertAllowed(action: GovernedAction): void {
    const decision = checkAccess(this.accessPolicy, this.options.principal, action);
    if (!decision.allowed) throw new Error(`access denied for ${action}: ${decision.reason}`);
  }

  private require(deploymentId: string): Deployment {
    const deployment = this.options.registry
      .listDeployments()
      .find((candidate) => candidate.deploymentId === deploymentId);
    if (deployment === undefined) throw new Error(`unknown deployment ${deploymentId}`);
    return deployment;
  }

  private advance(
    current: Deployment,
    to: DeploymentState,
    event: AuditEventType,
    correlationId: string | undefined,
    changes: {
      readonly approval?: Approval;
      readonly canary?: CanaryResult;
      readonly reason?: string;
    },
    extra: {
      readonly operator?: string;
      readonly reason?: string;
      readonly beforeAdvance?: () => void;
    } = {}
  ): Deployment {
    return this.transition(event, correlationId, () => {
      extra.beforeAdvance?.();
      const merged = {
        ...changes,
        lockOwner: this.options.lock.owner,
        ...(extra.reason !== undefined ? { reason: extra.reason } : {})
      };
      const advanced = advanceDeployment(
        current,
        transitionDeployment(current.state, to),
        merged,
        this.timestamp()
      );
      this.options.registry.saveDeployment(advanced);
      return {
        deployment: advanced,
        policyArtifactId: advanced.policyArtifactId,
        ...(extra.operator !== undefined ? { operator: extra.operator } : {}),
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        lockOwner: advanced.lockOwner ?? undefined
      };
    }).deployment;
  }

  /**
   * Hold the writer lease across one transition, then audit it.
   *
   * The audit event is written after the state is persisted, so the trail never
   * claims a transition that did not happen.
   */
  private transition<T extends {
    deployment: Deployment;
    policyArtifactId: string;
    operator?: string | undefined;
    reason?: string | undefined;
    lockOwner?: string | undefined;
  }>(
    event: AuditEventType,
    correlationId: string | undefined,
    operation: () => T
  ): T {
    return this.options.lock.withLock(() => {
      if (this.options.lock.recoveredStaleLock) {
        this.options.audit.record({
          type: 'lock.recovered',
          subject: 'deployment',
          subjectId: 'n/a',
          policyArtifactId: 'n/a',
          correlationId: correlationId ?? 'n/a',
          lockOwner: this.options.lock.owner,
          reason: `recovered an expired lease at ${this.options.lock.owner}`,
          at: this.timestamp()
        });
      }
      const result = operation();
      this.options.audit.record({
        type: event,
        subject: 'deployment',
        subjectId: result.deployment.deploymentId,
        policyArtifactId: result.policyArtifactId,
        correlationId: correlationId ?? result.deployment.deploymentId,
        at: this.timestamp(),
        ...(result.operator !== undefined ? { operator: result.operator } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(this.options.lock.owner !== undefined ? { lockOwner: this.options.lock.owner } : {})
      });
      return result;
    });
  }

  private assertArtifactDeployable(artifactId: string): void {
    const artifact = this.options.registry.policy(artifactId);
    if (artifact === undefined) throw new Error(`unknown policy artifact ${artifactId}`);
    // The checksum is the artifact's own identity: recompute it from the body.
    if (!verifyPolicyArtifact(artifact)) {
      throw new Error(`policy artifact ${artifactId} failed its checksum`);
    }
    const verifier = this.options.signatureVerifier;
    if (verifier === undefined) {
      throw new Error(`policy artifact ${artifactId} cannot be deployed: no signature verifier is configured`);
    }
    if (!verifier.verify(artifact)) {
      throw new Error(`policy artifact ${artifactId} failed signature verification`);
    }
  }

  /** The gate evidence is only valid while the policy it was taken against is still live. */
  private assertBaselineUnchanged(deployment: Deployment): void {
    const current = this.options.registry.currentPolicyArtifactId();
    if (current !== deployment.rollbackTarget) {
      throw new Error(
        `baseline moved since this deployment was proposed: expected ${deployment.rollbackTarget ?? 'none'}, found ${current ?? 'none'}`
      );
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * Unique within this writer. Two proposals for the same artifact in the same
   * millisecond must not collide, or the second would overwrite the first.
   */
  private nextDeploymentId(artifactId: string, evaluationId: string): string {
    this.sequence += 1;
    return `deploy-${artifactId.slice(0, 8)}-${evaluationId.slice(0, 8)}-${this.sequence}`;
  }
}


