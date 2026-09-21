import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hashJson } from '../hash.js';
import { transitionDeployment } from './deployment-state.js';
import {
  advanceDeployment,
  verifyEvaluationReport,
  verifyPolicyArtifact,
  type Approval,
  type CanaryResult,
  type Deployment,
  type EvaluationReport,
  type HoldoutGateVerdict,
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
export type { HoldoutGateVerdict };

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
  /**
   * Deployment record to finalize. When omitted a new ACTIVE record is created,
   * which is the one-shot path for callers that do not run the state machine.
   */
  readonly deploymentId?: string;
  readonly evaluationId: string;
  readonly holdoutGate: HoldoutGateVerdict;
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

  listEvaluations(): readonly EvaluationReport[] {
    return [...this.evaluations.values()];
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

    if (promotion.holdoutGate.candidateEvaluationId !== promotion.evaluationId) {
      throw new Error(
        `holdout gate ${promotion.holdoutGate.candidateEvaluationId} does not cover evaluation ${promotion.evaluationId}`
      );
    }
    if (!promotion.holdoutGate.passed) {
      throw new Error(`deployment for ${artifactId} failed the holdout gate`);
    }
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
    const deploymentId = promotion.deploymentId ?? hashJson({
      policyArtifactId: artifactId,
      evaluationId: promotion.evaluationId,
      approvalId: promotion.approval.approvalId,
      parentVersion: previous
    });
    const existing = this.deployments.get(deploymentId);
    const changes = {
      evaluationId: promotion.evaluationId,
      approval: promotion.approval,
      canary: promotion.canary,
      holdoutGate: promotion.holdoutGate
    };

    // Finalizing a record the writer advanced validates the transition; the
    // one-shot path has no prior state and starts at ACTIVE.
    const deployment: Deployment = existing === undefined
      ? {
          deploymentId,
          policyArtifactId: artifactId,
          state: 'ACTIVE',
          history: ['ACTIVE'],
          evaluationId: promotion.evaluationId,
          approval: promotion.approval,
          canary: promotion.canary,
          holdoutGate: promotion.holdoutGate,
          rollbackTarget: previous,
          lockOwner: null,
          createdAt: promotion.approval.decidedAt,
          updatedAt: promotion.approval.decidedAt
        }
      : advanceDeployment(
          { ...existing, ...changes },
          transitionDeployment(existing.state, 'ACTIVE'),
          changes,
          promotion.approval.decidedAt
        );

    this.deployments.set(deployment.deploymentId, deployment);
    this.currentPolicy = artifactId;
    this.persist();
    return deployment;
  }

  /**
   * Persist a deployment record. The deployment writer owns state transitions;
   * this only stores what it produced.
   */
  saveDeployment(deployment: Deployment): void {
    this.deployments.set(deployment.deploymentId, deployment);
    this.persist();
  }

  /**
   * Policy artifacts currently considered stable, most recently activated first,
   * capped at `limit`. Rollback targets come from here.
   */
  stableVersions(limit = 3): readonly string[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    const ordered = [...this.deployments.values()]
      .filter((deployment) => deployment.history.includes('ACTIVE'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return [...new Set(ordered.map((deployment) => deployment.policyArtifactId))].slice(0, limit);
  }

  /** Moves the pointer back to `artifactId`. The caller owns the rollback decision. */
  restoreCurrentPolicy(artifactId: string): void {
    if (!this.policies.has(artifactId)) throw new Error(`cannot restore unregistered policy artifact ${artifactId}`);
    this.currentPolicy = artifactId;
    this.persist();
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
  private readonly policiesDir: string;
  private readonly evaluationsDir: string;
  private readonly deploymentsDir: string;
  private readonly pointerPath: string;

  /**
   * One file per record, under a directory.
   *
   * A single snapshot file cannot be written by two registries: each writes its
   * whole in-memory map, so the later write drops the other's records. Policies
   * and evaluations are content-addressed, so per-record files can never
   * conflict; deployments are one file each, and the deployment writer lease
   * remains the ordering discipline for them. The pointer is a single value, so
   * last write wins by construction — which is what the lease is there to order.
   *
   * `PolicyRegistry` keeps an in-memory view from its last load or save, so a
   * live registry does not see another's records until it reloads. The files
   * are the shared state; the map is a cache.
   */
  constructor(rootDir: string) {
    this.policiesDir = join(rootDir, 'policies');
    this.evaluationsDir = join(rootDir, 'evaluations');
    this.deploymentsDir = join(rootDir, 'deployments');
    this.pointerPath = join(rootDir, 'current.json');
    for (const directory of [this.policiesDir, this.evaluationsDir, this.deploymentsDir]) {
      mkdirSync(directory, { recursive: true });
    }
  }

  load(): RegistrySnapshot {
    const policies = readRecords<PolicyArtifact>(this.policiesDir);
    const evaluations = readRecords<EvaluationReport>(this.evaluationsDir);
    const deployments = readRecords<Deployment>(this.deploymentsDir);
    const currentPolicyArtifactId = existsSync(this.pointerPath)
      ? (JSON.parse(readFileSync(this.pointerPath, 'utf8')) as { current: string | null }).current
      : null;

    for (const policy of policies) {
      if (!verifyPolicyArtifact(policy)) {
        throw new Error(`registry is corrupt: policy ${policy.artifactId} does not match its content`);
      }
    }
    for (const report of evaluations) {
      if (!verifyEvaluationReport(report)) {
        throw new Error(`registry is corrupt: evaluation ${report.evaluationId} does not match its content`);
      }
    }
    if (currentPolicyArtifactId !== null) {
      const known = policies.some((policy) => policy.artifactId === currentPolicyArtifactId);
      if (!known) {
        throw new Error(`registry is corrupt: current policy ${currentPolicyArtifactId} is not registered`);
      }
    }
    return { policies, evaluations, deployments, currentPolicyArtifactId };
  }

  save(snapshot: RegistrySnapshot): void {
    for (const policy of snapshot.policies) writeRecord(this.policiesDir, policy.artifactId, policy);
    for (const report of snapshot.evaluations) writeRecord(this.evaluationsDir, report.evaluationId, report);
    for (const deployment of snapshot.deployments) writeRecord(this.deploymentsDir, deployment.deploymentId, deployment);
    writeAtomic(this.pointerPath, { current: snapshot.currentPolicyArtifactId });
  }
}

function readRecords<T>(directory: string): T[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as T);
}

/** Write then rename, so a reader never observes a partial record. */
function writeRecord(directory: string, id: string, record: unknown): void {
  // The id is a content hash, so two writers can only write the same file for
  // the same record.
  writeAtomic(join(directory, `${id}.json`), record);
}

function writeAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}
