import { summarizeCaseResults, type CaseResult, type EvaluationMetrics, type FamilyRejectionSummary } from '../registry/models.js';
import { aggregate, rate, type Aggregate } from './statistics.js';
import type { PolicyRegistry } from '../registry/policy-registry.js';
import type { EvaluationSplitName } from '../evolution/split.js';
import type { MetricSummary, MetricsReader } from './metrics.js';

/**
 * Machine-readable observability report.
 *
 * Q/C/P/M/S are reported per evaluation and broken down by task family, because
 * an aggregate score hides which family regressed and by how much.
 */

export const OBSERVABILITY_REPORT_SCHEMA_VERSION = 1;

/**
 * Per-family metrics.
 *
 * An aggregate score hides which family regressed, and a mean without an
 * interval hides whether the sample can support the claim at all.
 */
export interface FamilyMetrics {
  readonly taskFamily: string;
  readonly caseCount: number;
  readonly passedCount: number;
  readonly quality: Aggregate;
  readonly cost: Aggregate;
  readonly latencyMs: Aggregate;
  readonly missRate: Aggregate;
  readonly rejectionSummary: readonly FamilyRejectionSummary[];
}

export interface EvaluationSummaryEntry {
  readonly evaluationId: string;
  readonly policyArtifactId: string;
  readonly split: EvaluationSplitName;
  readonly passed: boolean;
  readonly sampleCount: number;
  /** Quality, cost, parallel efficiency, miss rate, and score. */
  readonly metrics: EvaluationMetrics;
  readonly caseCount: number;
  readonly passedCaseCount: number;
  readonly families: readonly FamilyMetrics[];
}

export interface DeploymentSummaryEntry {
  readonly deploymentId: string;
  readonly policyArtifactId: string;
  readonly state: string;
  readonly history: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ObservabilityReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly currentPolicyArtifactId: string | null;
  readonly policyArtifactCount: number;
  readonly evaluations: readonly EvaluationSummaryEntry[];
  readonly deployments: readonly DeploymentSummaryEntry[];
  readonly metrics: readonly MetricSummary[];
}

export interface BuildReportInput {
  readonly registry: PolicyRegistry;
  readonly metrics?: MetricsReader;
  readonly generatedAt?: string;
}

export function buildObservabilityReport(input: BuildReportInput): ObservabilityReport {
  const evaluations = [...input.registry.listEvaluations()]
    .sort((left, right) => left.evaluationId.localeCompare(right.evaluationId))
    .map((report) => ({
      evaluationId: report.evaluationId,
      policyArtifactId: report.policyArtifactId,
      split: report.split,
      passed: report.passed,
      sampleCount: report.sampleCount,
      metrics: { ...report.metrics },
      caseCount: report.caseResults.length,
      passedCaseCount: report.caseResults.filter((result) => result.outcome === 'passed').length,
      families: summarizeFamilies(report.caseResults)
    }));

  const deployments = input.registry.listDeployments().map((deployment) => ({
    deploymentId: deployment.deploymentId,
    policyArtifactId: deployment.policyArtifactId,
    state: deployment.state,
    history: [...deployment.history],
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt
  }));

  return {
    schemaVersion: OBSERVABILITY_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    currentPolicyArtifactId: input.registry.currentPolicyArtifactId(),
    policyArtifactCount: input.registry.policyCount(),
    evaluations,
    deployments,
    metrics: input.metrics?.summary() ?? []
  };
}

/** Quality, cost, latency, and miss rate per family, with sample counts and intervals. */
function summarizeFamilies(caseResults: readonly CaseResult[]): readonly FamilyMetrics[] {
  const byFamily = new Map<string, CaseResult[]>();
  for (const result of caseResults) {
    byFamily.set(result.taskFamily, [...(byFamily.get(result.taskFamily) ?? []), result]);
  }

  return [...byFamily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskFamily, cases]) => {
      const failed = cases.filter((result) => result.outcome !== 'passed');
      return {
        taskFamily,
        caseCount: cases.length,
        passedCount: cases.length - failed.length,
        quality: aggregate(valuesOf(cases, 'quality')),
        cost: aggregate(valuesOf(cases, 'cost')),
        latencyMs: aggregate(valuesOf(cases, 'latencyMs')),
        // Absent is not "did not miss": scoring an unrecorded replay as clean
        // reports a rate the cases never supported. The aggregate's sample
        // count says how many cases recorded it.
        missRate: rate(valuesOf(cases, 'missed')),
        rejectionSummary: summarizeCaseResults(failed)
      };
    });
}

/**
 * A case that did not record a quantity is absent from that quantity's
 * aggregate, so a rate covers the cases that answered rather than scoring every
 * non-answer as false.
 */
function valuesOf(cases: readonly CaseResult[], field: 'quality' | 'cost' | 'latencyMs'): number[];
function valuesOf(cases: readonly CaseResult[], field: 'missed'): boolean[];
function valuesOf(
  cases: readonly CaseResult[],
  field: 'quality' | 'cost' | 'latencyMs' | 'missed'
): number[] | boolean[] {
  if (field === 'missed') {
    return cases
      .map((result) => result.missed)
      .filter((value): value is boolean => typeof value === 'boolean');
  }
  return cases
    .map((result) => result[field])
    .filter((value): value is number => typeof value === 'number');
}
