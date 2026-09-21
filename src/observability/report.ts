import { summarizeCaseResults, type EvaluationMetrics, type FamilyRejectionSummary } from '../registry/models.js';
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
  readonly families: readonly FamilyRejectionSummary[];
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
      families: summarizeCaseResults(report.caseResults)
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
