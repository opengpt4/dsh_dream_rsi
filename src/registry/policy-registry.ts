import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { hashJson } from '../hash.js';
import {
  verifyEvaluationReport,
  verifyPolicyArtifact,
  type Approval,
  type CanaryResult,
  type Deployment,
  type EvaluationReport,
  type PolicyArtifact
} from './models.js';

/**
 * Immutable registry of policies, evaluations, and deployments, plus the
 * current-policy pointer.
 *
 * Records are append-only and identified by their content hash. The pointer is
 * the only mutable state, and it moves only through {@link PolicyRegistry.promotePolicy},
 * which requires a registered artifact, a passing evaluation of that artifact,
 * an explicit operator approval, and a passing canary.
 */

export interface RegistrySnapshot {
  readonly policies: readonly PolicyArtifact[];
  readonly evaluations: readonly EvaluationReport[];
  readonly deployments: readonly Deployment[];
  readonly currentPolicyArtifactId: string | null;
}

/** Persistence port. The rules live in `PolicyRegistry`, not in a backend. */
export interface PolicyRegistryStore {
  load(): RegistrySnapshot;
  save(snapshot: RegistrySnapshot): void;
}

export const EMPTY_REGISTRY_SNAPSHOT: RegistrySnapshot = {
  policies: [],
  evaluations: [],
  deployments: [],
  currentPolicyArtifactId: null
};

export interface PolicyPromotion {
  readonly evaluationId: string;
  readonly approval: Approval;
  readonly canary: CanaryResult;
}

export class PolicyRegistry {
  private policies = new Map<string, PolicyArtifact>();
  private evaluations = new Map<string, EvaluationReport>();
  private deployments = new Map<string, Deployment>();
  private currentPolicy: string | null = null;

  constructor(private readonly store: PolicyRegistryStore) {
    const snapshot = store.load();
    for (const policy of snapshot.policies) this.policies.set(policy.artifactId, policy);
    for (const report of snapshot.evaluations) this.evaluations.set(report.evaluationId, report);
    for (const deployment of snapshot.deployments) this.deployments.set(deployment.deploymentId, deployment);
    this.currentPolicy = snapshot.currentPolicyArtifactId;
  }

  /** Register an artifact. Re-registering identical content is a no-op. */
  registerPolicy(artifact: PolicyArtifact): PolicyArtifact {
    if (!verifyPolicyArtifact(artifact)) {
      throw new Error(`policy artifact ${artifact.artifactId} does not match its content`);
    }
    const existing = this.policies.get(artifact.artifactId);
    if (existing !== undefined) return existing;
    this.policies.set(artifact.artifactId, artifact);
    this.persist();
    return artifact;
  }

  registerEvaluation(report: EvaluationReport): EvaluationReport {
    if (!verifyEvaluationReport(report)) {
      throw new Error(`evaluation report ${report.evaluationId} does not match its content`);
    }
    if (!this.policies.has(report.policyArtifactId)) {
      throw new Error(`evaluation ${report.evaluationId} references unregistered policy ${report.policyArtifactId}`);
    }
    const existing = this.evaluations.get(report.evaluationId);
    if (existing !== undefined) return existing;
    this.evaluations.set(report.evaluationId, report);
    this.persist();
    return report;
  }

  policy(artifactId: string): PolicyArtifact | undefined {
    return this.policies.get(artifactId);
  }

  evaluation(evaluationId: string): EvaluationReport | undefined {
    return this.evaluations.get(evaluationId);
  }

  evaluationsFor(artifactId: string): readonly EvaluationReport[] {
    return [...this.evaluations.values()]
      .filter((report) => report.policyArtifactId === artifactId)
      .sort((left, right) => left.evaluationId.localeCompare(right.evaluationId));
  }

  policyCount(): number {
    return this.policies.size;
  }

  evaluationCount(): number {
    return this.evaluations.size;
  }

  currentPolicyArtifactId(): string | null {
    return this.currentPolicy;
  }

  listDeployments(): readonly Deployment[] {
    return [...this.deployments.values()].sort((left, right) =>
      left.deploymentId.localeCompare(right.deploymentId)
    );
  }

  /** Most recently promoted deployment. Map iteration is insertion order. */
  latestDeployment(): Deployment | undefined {
    return [...this.deployments.values()].at(-1);
  }

  /**
   * Move the current-policy pointer.
   *
   * Every check runs before any mutation, so a rejected promotion leaves the
   * registry exactly as it was.
   */
  promotePolicy(artifactId: string, promotion: PolicyPromotion): Deployment {
    const artifact = this.policies.get(artifactId);
    if (artifact === undefined) throw new Error(`cannot promote unregistered policy artifact ${artifactId}`);

    if (promotion.approval.decision !== 'approved') {
      throw new Error(`deployment for ${artifactId} was not approved`);
    }
    if (!promotion.canary.passed) {
      throw new Error(`deployment for ${artifactId} failed canary: ${promotion.canary.failures.join(', ')}`);
    }

    const report = this.evaluations.get(promotion.evaluationId);
    if (report === undefined) throw new Error(`unknown evaluation ${promotion.evaluationId}`);
    if (report.policyArtifactId !== artifactId) {
      throw new Error(`evaluation ${report.evaluationId} does not cover policy ${artifactId}`);
    }
    if (!report.passed) throw new Error(`evaluation ${report.evaluationId} did not pass`);

    const previous = this.currentPolicy;
    const deployment: Deployment = {
      deploymentId: hashJson({
        policyArtifactId: artifactId,
        evaluationId: promotion.evaluationId,
        approvalId: promotion.approval.approvalId,
        parentVersion: previous
      }),
      policyArtifactId: artifactId,
      state: 'ACTIVE',
      evaluationId: promotion.evaluationId,
      approval: promotion.approval,
      canary: promotion.canary,
      rollbackTarget: previous,
      createdAt: promotion.approval.decidedAt
    };

    this.deployments.set(deployment.deploymentId, deployment);
    this.currentPolicy = artifactId;
    this.persist();
    return deployment;
  }

  private persist(): void {
    this.store.save({
      policies: [...this.policies.values()],
      evaluations: [...this.evaluations.values()],
      deployments: [...this.deployments.values()],
      currentPolicyArtifactId: this.currentPolicy
    });
  }
}

/** Keeps nothing: the registry lives for the life of the process. */
export class InMemoryPolicyRegistryStore implements PolicyRegistryStore {
  private snapshot: RegistrySnapshot = EMPTY_REGISTRY_SNAPSHOT;

  load(): RegistrySnapshot {
    return this.snapshot;
  }

  save(snapshot: RegistrySnapshot): void {
    this.snapshot = snapshot;
  }
}

/**
 * Persists the registry as one atomically written file.
 *
 * Every record is re-verified on load, so a tampered or truncated file is
 * rejected at construction rather than silently trusted.
 */
export class FilePolicyRegistryStore implements PolicyRegistryStore {
  constructor(private readonly filePath: string) {}

  load(): RegistrySnapshot {
    if (!existsSync(this.filePath)) return EMPTY_REGISTRY_SNAPSHOT;
    const snapshot = JSON.parse(readFileSync(this.filePath, 'utf8')) as RegistrySnapshot;

    for (const policy of snapshot.policies) {
      if (!verifyPolicyArtifact(policy)) {
        throw new Error(`registry file is corrupt: policy ${policy.artifactId} does not match its content`);
      }
    }
    for (const report of snapshot.evaluations) {
      if (!verifyEvaluationReport(report)) {
        throw new Error(`registry file is corrupt: evaluation ${report.evaluationId} does not match its content`);
      }
    }
    if (snapshot.currentPolicyArtifactId !== null) {
      const known = snapshot.policies.some((policy) => policy.artifactId === snapshot.currentPolicyArtifactId);
      if (!known) {
        throw new Error(`registry file is corrupt: current policy ${snapshot.currentPolicyArtifactId} is not registered`);
      }
    }
    return snapshot;
  }

  save(snapshot: RegistrySnapshot): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(temporaryPath, this.filePath);
  }
}
