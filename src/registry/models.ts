import { createHash } from 'node:crypto';

import { hashJson } from '../hash.js';
import { toArtifactRef, type ArtifactRef, type ArtifactStore } from '../artifacts/store.js';
import type { JsonValue } from '../discovery/models.js';
import type { EvaluationSplitName } from '../evolution/split.js';

/**
 * Immutable policy, evaluation, and deployment records.
 *
 * Every record's identity is the hash of its own content, so two records with
 * the same id are the same record and a registry can reject a body that does
 * not match the id it claims.
 */

export const POLICY_ARTIFACT_SCHEMA_VERSION = 1;

export type CreatedBy = 'human' | 'evolution-agent';

export interface PolicyManifest {
  readonly entrypoint: string;
  readonly dependencies: readonly string[];
  readonly schemaVersion: number;
}

export interface PolicyArtifact {
  /** SHA-256 over the artifact body below, excluding `createdAt`. */
  readonly artifactId: string;
  readonly version: string;
  /** Version this supersedes, or `null` for the initial policy. */
  readonly parentVersion: string | null;
  readonly sourceSha256: string;
  /**
   * Where the source bytes live. Absent means the source was never stored, so
   * the artifact's identity is verifiable but its content is not retrievable.
   *
   * Not part of the artifact id: the id covers what the artifact is, and
   * `sourceSha256` already binds the content. A reference is a location.
   */
  readonly sourceRef?: ArtifactRef;
  readonly manifest: PolicyManifest;
  readonly allowedCapabilities: readonly string[];
  readonly createdBy: CreatedBy;
  readonly createdAt: string;
}

export type CaseOutcome = 'passed' | 'failed' | 'error';

export interface CaseResult {
  readonly caseId: string;
  readonly taskFamily: string;
  readonly split: EvaluationSplitName;
  readonly outcome: CaseOutcome;
  /** Per-case quality, required by the holdout gate to compare two runs. */
  readonly quality?: number;
  /** Per-case score, required by the holdout gate to measure improvement. */
  readonly score?: number;
  /** Per-case cost and wall-clock latency, aggregated per task family. */
  readonly cost?: number;
  readonly latencyMs?: number;
  /** Whether this case's replay missed, which is the per-family miss rate. */
  readonly missed?: boolean;
  /** Why a non-passing case failed. Absent when the case passed. */
  readonly reason?: string;
}

export interface GuardResult {
  readonly guard: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface EvaluationMetrics {
  readonly quality: number;
  readonly cost: number;
  readonly parallelEfficiency: number;
  readonly missRate: number;
  readonly score: number;
}

export interface EvaluationReport {
  /** SHA-256 over the report body below, excluding `createdAt`. */
  readonly evaluationId: string;
  readonly evaluatorVersion: string;
  readonly sourceHash: string;
  readonly snapshotId: string;
  readonly policyArtifactId: string;
  readonly split: EvaluationSplitName;
  readonly configHash: string;
  readonly metrics: EvaluationMetrics;
  readonly caseResults: readonly CaseResult[];
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly guardResults: readonly GuardResult[];
  readonly createdAt: string;
}

/**
 * Holdout verdict a promotion rests on.
 *
 * Structural rather than imported from the gate module, and checked against the
 * evaluation it covers, so a verdict taken over some other evaluation cannot
 * justify a promotion.
 */
export interface HoldoutGateVerdict {
  readonly passed: boolean;
  readonly candidateEvaluationId: string;
}

export type DeploymentState =
  | 'PROPOSED'
  | 'APPROVED'
  | 'CANARY'
  | 'ACTIVE'
  | 'REJECTED'
  | 'ROLLED_BACK'
  | 'DEGRADED';

export interface Approval {
  readonly approvalId: string;
  /** Operator identity. Approval is never implicit, so this is always present. */
  readonly operator: string;
  readonly decision: 'approved' | 'rejected';
  readonly reason?: string;
  readonly decidedAt: string;
}

export interface CanaryThresholds {
  readonly minQuality: number;
  readonly maxErrorRate: number;
  readonly maxLatencyMs: number;
  readonly maxCost: number;
  readonly maxMissRate: number;
}

export interface CanaryObservation {
  readonly quality: number;
  readonly errorRate: number;
  readonly latencyMs: number;
  readonly cost: number;
  readonly missRate: number;
}

export interface CanaryResult {
  readonly passed: boolean;
  readonly observation: CanaryObservation;
  readonly thresholds: CanaryThresholds;
  /** Names of the thresholds that were breached, in a stable order. */
  readonly failures: readonly string[];
  readonly observedAt: string;
}

export interface Deployment {
  readonly deploymentId: string;
  readonly policyArtifactId: string;
  readonly state: DeploymentState;
  /** Every state this deployment passed through, in order. */
  readonly history: readonly DeploymentState[];
  /** Absent until the deployment is gated on an evaluation. */
  readonly evaluationId: string | null;
  /** Absent until an operator decides. */
  readonly approval: Approval | null;
  /** Absent until a canary has run. */
  readonly canary: CanaryResult | null;
  /**
   * The verdict this deployment was proposed on. Carried rather than recomputed
   * so activation re-checks the evidence that was actually reviewed.
   */
  readonly holdoutGate: HoldoutGateVerdict | null;
  /** Policy to return to on rollback, or `null` for the first deployment. */
  readonly rollbackTarget: string | null;
  /** Held by the writer that last transitioned this record. */
  readonly lockOwner: string | null;
  /** Why the deployment left the happy path, when it did. */
  readonly reason?: string;
  /**
   * When this deployment became ACTIVE.
   *
   * Kept apart from `updatedAt`, which moves on every later transition: a
   * deployment that was degraded has a recent `updatedAt` and an old
   * activation, and ordering stable versions by the former puts it first.
   */
  readonly activatedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Applies a state transition, recording it in `history`. */
export function advanceDeployment(
  deployment: Deployment,
  to: DeploymentState,
  changes: Partial<Pick<Deployment, 'evaluationId' | 'approval' | 'canary' | 'holdoutGate' | 'lockOwner' | 'reason'>>,
  updatedAt: string
): Deployment {
  return {
    ...deployment,
    ...changes,
    state: to,
    history: [...deployment.history, to],
    ...(to === 'ACTIVE' ? { activatedAt: updatedAt } : {}),
    updatedAt
  };
}

export interface PolicyArtifactInput {
  readonly version: string;
  readonly parentVersion: string | null;
  readonly source: string;
  readonly manifest: PolicyManifest;
  readonly allowedCapabilities: readonly string[];
  readonly createdBy: CreatedBy;
  readonly createdAt?: string;
}

interface PolicyArtifactBody {
  readonly version: string;
  readonly parentVersion: string | null;
  readonly sourceSha256: string;
  readonly manifest: PolicyManifest;
  readonly allowedCapabilities: readonly string[];
  readonly createdBy: CreatedBy;
}

/** Content the artifact id is taken over. `createdAt` is metadata, not identity. */
function policyArtifactBody(body: PolicyArtifactBody): JsonValue {
  return {
    schemaVersion: POLICY_ARTIFACT_SCHEMA_VERSION,
    version: body.version,
    parentVersion: body.parentVersion,
    sourceSha256: body.sourceSha256,
    manifest: {
      entrypoint: body.manifest.entrypoint,
      dependencies: [...body.manifest.dependencies],
      schemaVersion: body.manifest.schemaVersion
    },
    allowedCapabilities: [...body.allowedCapabilities],
    createdBy: body.createdBy
  };
}

export function createPolicyArtifact(input: PolicyArtifactInput, sourceRef?: ArtifactRef): PolicyArtifact {
  validatePolicyArtifactInput(input);
  const sourceSha256 = sha256(input.source);
  return {
    artifactId: hashJson(
      policyArtifactBody({ ...input, sourceSha256 })
    ),
    version: input.version,
    parentVersion: input.parentVersion,
    sourceSha256,
    ...(sourceRef !== undefined ? { sourceRef } : {}),
    manifest: {
      entrypoint: input.manifest.entrypoint,
      dependencies: [...input.manifest.dependencies],
      schemaVersion: input.manifest.schemaVersion
    },
    allowedCapabilities: [...input.allowedCapabilities],
    createdBy: input.createdBy,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

/** Recompute the id from the body; a mismatch means the record was altered. */
export function verifyPolicyArtifact(artifact: PolicyArtifact): boolean {
  return artifact.artifactId === hashJson(policyArtifactBody(artifact));
}

/**
 * Store a policy artifact's source and return the artifact with its reference.
 *
 * Recording a reference without the bytes would leave an artifact whose source
 * is unretrievable, which is what `sourceRef` exists to prevent.
 */
export function createPolicyArtifactWithSource(store: ArtifactStore, input: PolicyArtifactInput): PolicyArtifact {
  const metadata = store.put({
    bytes: Buffer.from(input.source, 'utf8'),
    kind: 'policy',
    mediaType: 'text/plain',
    schemaVersion: input.manifest.schemaVersion
  });
  return createPolicyArtifact(input, toArtifactRef(metadata));
}

/**
 * Check that the referenced bytes are the source this artifact was built from.
 *
 * A reference whose content does not hash to `sourceSha256` points at something
 * other than the reviewed source.
 */
export function verifyPolicyArtifactSource(artifact: PolicyArtifact, store: ArtifactStore): boolean {
  if (artifact.sourceRef === undefined) return false;
  if (!store.verify(artifact.sourceRef.artifactId).ok) return false;
  const bytes = store.get(artifact.sourceRef.artifactId);
  if (bytes === undefined) return false;
  return sha256(bytes.toString('utf8')) === artifact.sourceSha256;
}

export type EvaluationReportInput = Omit<EvaluationReport, 'evaluationId' | 'createdAt'> & {
  readonly createdAt?: string;
};

function evaluationReportBody(report: EvaluationReport | EvaluationReportInput): JsonValue {
  return {
    schemaVersion: POLICY_ARTIFACT_SCHEMA_VERSION,
    evaluatorVersion: report.evaluatorVersion,
    sourceHash: report.sourceHash,
    snapshotId: report.snapshotId,
    policyArtifactId: report.policyArtifactId,
    split: report.split,
    configHash: report.configHash,
    metrics: {
      quality: report.metrics.quality,
      cost: report.metrics.cost,
      parallelEfficiency: report.metrics.parallelEfficiency,
      missRate: report.metrics.missRate,
      score: report.metrics.score
    },
    caseResults: report.caseResults.map((result) => ({
      caseId: result.caseId,
      taskFamily: result.taskFamily,
      split: result.split,
      outcome: result.outcome,
      ...(result.quality !== undefined ? { quality: result.quality } : {}),
      ...(result.score !== undefined ? { score: result.score } : {}),
      ...(result.cost !== undefined ? { cost: result.cost } : {}),
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      ...(result.missed !== undefined ? { missed: result.missed } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {})
    })),
    sampleCount: report.sampleCount,
    passed: report.passed,
    guardResults: report.guardResults.map((result) => ({
      guard: result.guard,
      passed: result.passed,
      ...(result.detail !== undefined ? { detail: result.detail } : {})
    }))
  };
}

export function createEvaluationReport(input: EvaluationReportInput): EvaluationReport {
  // Rebuilt field by field rather than spread. The parameter type omits
  // `evaluationId`, but an untyped caller can pass it anyway, and a spread
  // would let that value replace the computed hash — returning a report that
  // fails its own verification and claims another report's identity.
  const report: Omit<EvaluationReport, 'evaluationId'> = {
    evaluatorVersion: input.evaluatorVersion,
    sourceHash: input.sourceHash,
    snapshotId: input.snapshotId,
    policyArtifactId: input.policyArtifactId,
    split: input.split,
    configHash: input.configHash,
    metrics: input.metrics,
    caseResults: input.caseResults,
    sampleCount: input.sampleCount,
    passed: input.passed,
    guardResults: input.guardResults,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
  return { evaluationId: hashJson(evaluationReportBody(report)), ...report };
}

export function verifyEvaluationReport(report: EvaluationReport): boolean {
  return report.evaluationId === hashJson(evaluationReportBody(report));
}

/** Evaluate canary thresholds. Breaches are named, not merely counted. */
export function summarizeCanary(
  observation: CanaryObservation,
  thresholds: CanaryThresholds,
  observedAt: string = new Date().toISOString()
): CanaryResult {
  const failures: string[] = [];
  if (observation.quality < thresholds.minQuality) failures.push('quality');
  if (observation.errorRate > thresholds.maxErrorRate) failures.push('errorRate');
  if (observation.latencyMs > thresholds.maxLatencyMs) failures.push('latencyMs');
  if (observation.cost > thresholds.maxCost) failures.push('cost');
  if (observation.missRate > thresholds.maxMissRate) failures.push('missRate');
  return { passed: failures.length === 0, observation, thresholds, failures, observedAt };
}

export interface FamilyRejectionSummary {
  readonly taskFamily: string;
  readonly caseCount: number;
  readonly passedCount: number;
  /** Failure reason to occurrences, most frequent first. */
  readonly reasons: Readonly<Record<string, number>>;
}

/**
 * Why cases failed, grouped by task family.
 *
 * A single aggregate rejection count hides which family is failing and why,
 * which is the part that can actually be acted on.
 */
export function summarizeCaseResults(caseResults: readonly CaseResult[]): readonly FamilyRejectionSummary[] {
  const byFamily = new Map<string, { caseCount: number; passedCount: number; reasons: Map<string, number> }>();

  for (const result of caseResults) {
    const entry = byFamily.get(result.taskFamily) ?? { caseCount: 0, passedCount: 0, reasons: new Map() };
    entry.caseCount += 1;
    if (result.outcome === 'passed') {
      entry.passedCount += 1;
    } else {
      const reason = result.reason ?? '(unspecified)';
      entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
    }
    byFamily.set(result.taskFamily, entry);
  }

  return [...byFamily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskFamily, entry]) => ({
      taskFamily,
      caseCount: entry.caseCount,
      passedCount: entry.passedCount,
      reasons: Object.fromEntries(
        [...entry.reasons.entries()].sort(([leftReason, leftCount], [rightReason, rightCount]) =>
          rightCount - leftCount || leftReason.localeCompare(rightReason)
        )
      )
    }));
}

function validatePolicyArtifactInput(input: PolicyArtifactInput): void {
  if (input.version.trim().length === 0) throw new Error('policy version must not be empty');
  if (input.manifest.entrypoint.trim().length === 0) throw new Error('policy manifest entrypoint must not be empty');
  if (!Number.isInteger(input.manifest.schemaVersion) || input.manifest.schemaVersion <= 0) {
    throw new Error('policy manifest schemaVersion must be a positive integer');
  }
  if (input.parentVersion !== null && input.parentVersion === input.version) {
    throw new Error('policy parentVersion must differ from version');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
