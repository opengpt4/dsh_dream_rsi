import type { DiscoveryNode } from '../discovery/models.js';

export interface EvaluatorConfig {
  readonly qualityReference: number;
  readonly costBudget: number;
  readonly idealParallelEfficiency: number;
  readonly gamma: number;
  readonly qualityWeight: number;
  readonly costWeight: number;
  readonly parallelWeight: number;
  readonly boundaryPenalty: number;
}

export interface EvaluationInput {
  readonly visitedNodes: readonly DiscoveryNode[];
  readonly boundaryMissCount: number;
  readonly totalAttempts: number;
  readonly criticalPathMs: number;
}

export interface EvaluationResult {
  readonly quality: number;
  readonly cost: number;
  readonly parallelEfficiency: number;
  readonly missRate: number;
  readonly score: number;
}

export const DEFAULT_EVALUATOR_CONFIG: EvaluatorConfig = {
  qualityReference: 1,
  costBudget: 1000,
  idealParallelEfficiency: 1,
  gamma: 0.1,
  qualityWeight: 1,
  costWeight: 0.3,
  parallelWeight: 0.1,
  boundaryPenalty: 10
};

/**
 * Refuse a coefficient that would invert what the score means.
 *
 * `positive` guards the references and budgets because they are scales: a
 * nonsensical one is replaced by one and the score keeps its meaning. A
 * coefficient is a direction, not a scale. A negative `costWeight` rewards
 * spending, a negative `boundaryPenalty` rewards misses, and a negative `gamma`
 * subtracts execution time from cost — each silently produces a score that says
 * the opposite of what the field name claims. A non-finite coefficient poisons
 * every score it touches. So these are refused rather than adjusted.
 *
 * The config reaches the evaluator from the host and, for an isolated run, over
 * the child's stdin: the child calls this too, which is what stops a run from
 * being scored under coefficients the parent never intended.
 */
export function assertEvaluatorConfig(config: EvaluatorConfig): void {
  const coefficients = [
    ['gamma', config.gamma],
    ['qualityWeight', config.qualityWeight],
    ['costWeight', config.costWeight],
    ['parallelWeight', config.parallelWeight],
    ['boundaryPenalty', config.boundaryPenalty]
  ] as const;
  for (const [name, value] of coefficients) {
    if (!Number.isFinite(value)) throw new Error(`evaluator ${name} must be finite, received ${value}`);
    if (value < 0) throw new Error(`evaluator ${name} must not be negative, received ${value}`);
  }
}

export function evaluateReplay(
  input: EvaluationInput,
  config: EvaluatorConfig = DEFAULT_EVALUATOR_CONFIG
): EvaluationResult {
  assertEvaluatorConfig(config);
  const qualityRaw = input.visitedNodes.length === 0
    ? 0
    : Math.max(...input.visitedNodes.map((node) => node.score));
  const workCost = input.visitedNodes.reduce(
    (total, node) => total + node.tokenCost + config.gamma * node.execTimeMs,
    0
  );
  const totalExecTime = input.visitedNodes.reduce((total, node) => total + node.execTimeMs, 0);
  const quality = qualityRaw / positive(config.qualityReference);
  const cost = workCost / positive(config.costBudget);
  const rawParallelEfficiency = totalExecTime / positive(input.criticalPathMs);
  const parallelEfficiency = rawParallelEfficiency / positive(config.idealParallelEfficiency);
  const missRate = input.boundaryMissCount / Math.max(input.totalAttempts, 1);
  const score = config.qualityWeight * quality
    - config.costWeight * cost
    + config.parallelWeight * parallelEfficiency
    - config.boundaryPenalty * missRate;

  return { quality, cost, parallelEfficiency, missRate, score };
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}