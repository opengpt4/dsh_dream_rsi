import { createHash } from 'node:crypto';

import { hashJson } from '../hash.js';
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
  readonly evaluationId: string;
  readonly approval: Approval;
  readonly canary: CanaryResult;
  /** Policy to return to on rollback, or `null` for the first deployment. */
  readonly rollbackTarget: string | null;
  readonly createdAt: string;
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

export function createPolicyArtifact(input: PolicyArtifactInput): PolicyArtifact {
  validatePolicyArtifactInput(input);
  const sourceSha256 = sha256(input.source);
  return {
    artifactId: hashJson(
      policyArtifactBody({ ...input, sourceSha256 })
    ),
    version: input.version,
    parentVersion: input.parentVersion,
    sourceSha256,
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
  return {
    evaluationId: hashJson(evaluationReportBody(input)),
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
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
