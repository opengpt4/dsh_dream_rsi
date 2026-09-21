import {
  summarizeCaseResults,
  type EvaluationReport,
  type FamilyRejectionSummary
} from '../registry/models.js';
import { evaluateMonotonicGate, type MonotonicGateResult } from './monotonic-gate.js';

/**
 * The holdout gate: the evidence a candidate must produce before it may be
 * promoted.
 *
 * It compares two evaluation reports over the identical holdout case set and
 * checks each requirement independently, so a candidate cannot trade a quality
 * regression against a cost win. Every rejection reason is recorded, together
 * with the configuration the verdict was taken under.
 */

export interface HoldoutGateConfig {
  /** Fraction of cases whose candidate quality must not fall below the incumbent's. */
  readonly minimumPassRatio: number;
  /** Required mean-score gain over the incumbent. */
  readonly minimumImprovement: number;
  readonly minimumHoldoutSamples: number;
  readonly maxMissRate: number;
  readonly minQuality: number;
  readonly maxCost: number;
  readonly minParallelEfficiency: number;
}

export const DEFAULT_HOLDOUT_GATE_CONFIG: HoldoutGateConfig = {
  minimumPassRatio: 0.95,
  minimumImprovement: 0.01,
  minimumHoldoutSamples: 20,
  maxMissRate: 0.05,
  minQuality: 0,
  maxCost: 1,
  minParallelEfficiency: 0
};

export interface HoldoutFamilyVerdict {
  readonly taskFamily: string;
  readonly caseCount: number;
  readonly passedCount: number;
  readonly passRatio: number;
  readonly passed: boolean;
  /** Rejection reasons for this family's cases, most frequent first. */
  readonly rejectionSummary: readonly FamilyRejectionSummary[];
}

export interface HoldoutGateInput {
  readonly incumbent: EvaluationReport;
  readonly candidate: EvaluationReport;
  readonly config: HoldoutGateConfig;
  /** Hash of the runtime configuration both reports were produced under. */
  readonly configurationHash: string;
}

export interface HoldoutGateResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly configurationHash: string;
  readonly incumbentEvaluationId: string;
  readonly candidateEvaluationId: string;
  readonly passRatio: number;
  readonly scoreImprovement: number;
  readonly failedCaseIds: readonly string[];
  readonly sampleCount: number;
  readonly monotonic: MonotonicGateResult;
  readonly families: readonly HoldoutFamilyVerdict[];
}

export function evaluateHoldoutGate(input: HoldoutGateInput): HoldoutGateResult {
  const { incumbent, candidate, config } = input;
  validateConfig(config);

  const reasons: string[] = [];
  const caseFailures: string[] = [];

  // Both sides must be holdout evidence. Comparing a holdout candidate against a
  // train incumbent would report a gain that no unseen task supports.
  if (incumbent.split !== 'holdout') reasons.push(`incumbent evaluation is on the ${incumbent.split} split, not holdout`);
  if (candidate.split !== 'holdout') reasons.push(`candidate evaluation is on the ${candidate.split} split, not holdout`);

  if (candidate.configHash !== input.configurationHash || incumbent.configHash !== input.configurationHash) {
    reasons.push('both evaluations must be produced under the configuration being gated');
  }

  const incumbentCases = readCases(incumbent, 'incumbent', reasons);
  const candidateCases = readCases(candidate, 'candidate', reasons);
  assertSameFamilies(incumbent, candidate, reasons);

  const monotonic = evaluateMonotonicGate(incumbentCases, candidateCases, {
    minimumPassRatio: config.minimumPassRatio,
    minimumImprovement: config.minimumImprovement
  });
  reasons.push(...monotonic.reasons);
  caseFailures.push(...monotonic.failedCaseIds);

  if (candidate.sampleCount < config.minimumHoldoutSamples) {
    reasons.push(
      `candidate holdout sample count ${candidate.sampleCount} is below the minimum of ${config.minimumHoldoutSamples}`
    );
  }
  if (candidate.metrics.missRate > config.maxMissRate) {
    reasons.push(`candidate miss rate ${candidate.metrics.missRate} exceeds the maximum of ${config.maxMissRate}`);
  }
  // Budgets are checked one at a time: a cheap policy that regresses quality must
  // not pass on cost.
  if (candidate.metrics.quality < config.minQuality) {
    reasons.push(`candidate quality ${candidate.metrics.quality} is below the minimum of ${config.minQuality}`);
  }
  if (candidate.metrics.cost > config.maxCost) {
    reasons.push(`candidate cost ${candidate.metrics.cost} exceeds the maximum of ${config.maxCost}`);
  }
  if (candidate.metrics.parallelEfficiency < config.minParallelEfficiency) {
    reasons.push(
      `candidate parallel efficiency ${candidate.metrics.parallelEfficiency} is below the minimum of ${config.minParallelEfficiency}`
    );
  }

  const failedGuards = candidate.guardResults.filter((result) => !result.passed).map((result) => result.guard);
  if (failedGuards.length > 0) reasons.push(`candidate failed guard(s): ${failedGuards.join(', ')}`);

  const families = summarizeFamilies(incumbent, candidate, config);
  for (const family of families) {
    if (!family.passed) reasons.push(`task family ${family.taskFamily} pass ratio ${family.passRatio} is below ${config.minimumPassRatio}`);
  }

  return deepFreeze({
    passed: reasons.length === 0,
    reasons,
    configurationHash: input.configurationHash,
    incumbentEvaluationId: incumbent.evaluationId,
    candidateEvaluationId: candidate.evaluationId,
    passRatio: monotonic.passRatio,
    scoreImprovement: monotonic.scoreImprovement,
    failedCaseIds: [...new Set(caseFailures)],
    sampleCount: candidate.sampleCount,
    monotonic,
    families
  });
}

function summarizeFamilies(
  incumbent: EvaluationReport,
  candidate: EvaluationReport,
  config: HoldoutGateConfig
): HoldoutFamilyVerdict[] {
  const incumbentByCase = new Map(incumbent.caseResults.map((result) => [result.caseId, result]));
  const byFamily = new Map<string, { caseCount: number; passedCount: number; failing: typeof candidate.caseResults }>();

  for (const candidateCase of candidate.caseResults) {
    const entry = byFamily.get(candidateCase.taskFamily) ?? { caseCount: 0, passedCount: 0, failing: [] };
    const baseline = incumbentByCase.get(candidateCase.caseId);
    entry.caseCount += 1;
    if (baseline !== undefined && (candidateCase.quality ?? 0) >= (baseline.quality ?? 0)) entry.passedCount += 1;
    else entry.failing = [...entry.failing, candidateCase];
    byFamily.set(candidateCase.taskFamily, entry);
  }

  return [...byFamily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskFamily, entry]) => {
      const passRatio = entry.caseCount === 0 ? 0 : entry.passedCount / entry.caseCount;
      return {
        taskFamily,
        caseCount: entry.caseCount,
        passedCount: entry.passedCount,
        passRatio,
        passed: passRatio >= config.minimumPassRatio,
        rejectionSummary: summarizeCaseResults(entry.failing)
      };
    });
}

/**
 * The gate needs per-case quality to compare two runs case by case. A report
 * without it cannot support a monotonic verdict, so it is rejected rather than
 * treated as equal.
 */
function readCases(
  report: EvaluationReport,
  label: string,
  reasons: string[]
): Array<{ caseId: string; quality: number; score: number }> {
  const missing = report.caseResults.filter((result) => result.quality === undefined || result.score === undefined);
  if (missing.length > 0) {
    reasons.push(`${label} evaluation is missing per-case quality or score for ${missing.length} case(s)`);
  }
  return report.caseResults.map((result) => ({
    caseId: result.caseId,
    quality: result.quality ?? 0,
    score: result.score ?? 0
  }));
}

/**
 * The verdict is per task family, so a case must be in the same family in both
 * reports.
 *
 * Comparing case ids alone left the family label to the candidate: relabelling
 * the cases of a regressing family into one that passes merged them into a
 * family that met the ratio, and the per-family check had nothing left to fail
 * on. Case ids match, so the mismatch is in what the two reports say the case
 * is.
 */
function assertSameFamilies(
  incumbent: EvaluationReport,
  candidate: EvaluationReport,
  reasons: string[]
): void {
  const incumbentFamily = new Map(
    incumbent.caseResults.map((result) => [result.caseId, result.taskFamily])
  );
  const relabelled = candidate.caseResults.filter((result) => {
    const family = incumbentFamily.get(result.caseId);
    return family !== undefined && family !== result.taskFamily;
  });
  if (relabelled.length > 0) {
    const first = relabelled[0]!;
    reasons.push(
      `${relabelled.length} case(s) are in a different task family in each report, starting with ${first.caseId} ` +
        `(${incumbentFamily.get(first.caseId)} vs ${first.taskFamily})`
    );
  }
}

function validateConfig(config: HoldoutGateConfig): void {
  if (!Number.isInteger(config.minimumHoldoutSamples) || config.minimumHoldoutSamples < 0) {
    throw new Error('minimumHoldoutSamples must be a non-negative integer');
  }
  for (const [value, name] of [
    [config.maxMissRate, 'maxMissRate'],
    [config.maxCost, 'maxCost'],
    [config.minQuality, 'minQuality'],
    [config.minParallelEfficiency, 'minParallelEfficiency']
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
