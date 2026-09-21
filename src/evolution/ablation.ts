import type { DiscoveryNode } from '../discovery/models.js';
import { bucketFor, type EvaluationSplitConfig, type EvaluationSplitName } from './split.js';
import {
  evaluateReplay,
  DEFAULT_EVALUATOR_CONFIG,
  type EvaluationInput,
  type EvaluationResult,
  type EvaluatorConfig
} from './evaluator.js';

/**
 * Ablation study over the evaluator terms and the split strategy.
 *
 * This decomposes a recorded result; it is architecture validation, not a
 * performance claim. The technical paper says the same thing, and the release
 * blockers forbid a performance claim drawn only from replay fixtures.
 */

export const ABLATION_SCHEMA_VERSION = 1;

export interface AblationVariant {
  readonly name: string;
  readonly detail: string;
  readonly evaluator: EvaluatorConfig;
}

/**
 * Each variant removes one term.
 *
 * A variant's `scoreDelta` is its score minus the baseline's, so the sign
 * depends on the term: removing a penalty raises the score by that penalty's
 * magnitude, while removing the parallel bonus lowers it by the bonus.
 */
export function evaluatorAblations(
  baseline: EvaluatorConfig = DEFAULT_EVALUATOR_CONFIG
): readonly AblationVariant[] {
  return [
    { name: 'baseline', detail: 'the configured evaluator', evaluator: baseline },
    { name: 'no-boundary-penalty', detail: 'boundaryPenalty = 0', evaluator: { ...baseline, boundaryPenalty: 0 } },
    { name: 'no-cost-term', detail: 'costWeight = 0', evaluator: { ...baseline, costWeight: 0 } },
    { name: 'no-parallel-term', detail: 'parallelWeight = 0', evaluator: { ...baseline, parallelWeight: 0 } },
    {
      name: 'quality-only',
      detail: 'cost, parallel, and boundary terms removed',
      evaluator: { ...baseline, costWeight: 0, parallelWeight: 0, boundaryPenalty: 0 }
    }
  ];
}

export interface AblationRun {
  readonly name: string;
  readonly detail: string;
  readonly metrics: EvaluationResult;
  /** Difference in score from the baseline variant. */
  readonly scoreDelta: number;
}

export function ablateEvaluator(
  input: EvaluationInput,
  baseline: EvaluatorConfig = DEFAULT_EVALUATOR_CONFIG
): readonly AblationRun[] {
  const variants = evaluatorAblations(baseline);
  const baselineScore = evaluateReplay(input, variants[0]!.evaluator).score;

  return variants.map((variant) => {
    const metrics = evaluateReplay(input, variant.evaluator);
    return {
      name: variant.name,
      detail: variant.detail,
      metrics,
      // Rounded: the delta is a diagnostic, and float noise would suggest
      // precision the comparison does not have.
      scoreDelta: round(metrics.score - baselineScore)
    };
  });
}

export interface SplitAblation {
  readonly strategy: 'task-level' | 'node-level';
  readonly detail: string;
  readonly partitions: Readonly<Record<EvaluationSplitName, number>>;
  /** Tasks whose nodes landed in more than one partition. */
  readonly tasksInMultiplePartitions: readonly string[];
  readonly leaks: boolean;
}

/**
 * Compare the task-level split against a node-level one.
 *
 * A node-level split puts one task's nodes in several partitions, so holdout
 * contains states the policy was already evaluated on. That is the leakage the
 * task-level split exists to prevent, and this makes the difference visible
 * rather than asserted.
 */
export function ablateSplit(
  nodes: readonly DiscoveryNode[],
  config: EvaluationSplitConfig
): readonly SplitAblation[] {
  const taskLevel = new Map<string, EvaluationSplitName>();
  for (const taskId of [...new Set(nodes.map((node) => node.taskId))].sort()) {
    taskLevel.set(taskId, bucketFor(taskId, config));
  }
  const nodeLevel = new Map<string, EvaluationSplitName>();
  for (const node of nodes) nodeLevel.set(node.nodeId, bucketFor(`node:${node.nodeId}`, config));

  return [
    describe('task-level', 'every node of a task shares one partition', nodes, (node) => taskLevel.get(node.taskId)!),
    describe('node-level', 'each node is bucketed on its own id', nodes, (node) => nodeLevel.get(node.nodeId)!)
  ];
}

function describe(
  strategy: SplitAblation['strategy'],
  detail: string,
  nodes: readonly DiscoveryNode[],
  assign: (node: DiscoveryNode) => EvaluationSplitName
): SplitAblation {
  const partitions: Record<EvaluationSplitName, number> = { train: 0, validation: 0, holdout: 0 };
  const partitionsByTask = new Map<string, Set<EvaluationSplitName>>();

  for (const node of nodes) {
    const partition = assign(node);
    partitions[partition] += 1;
    partitionsByTask.set(node.taskId, (partitionsByTask.get(node.taskId) ?? new Set()).add(partition));
  }

  const tasksInMultiplePartitions = [...partitionsByTask.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([taskId]) => taskId)
    .sort();

  return {
    strategy,
    detail,
    partitions,
    tasksInMultiplePartitions,
    leaks: tasksInMultiplePartitions.length > 0
  };
}

export interface AblationStudy {
  readonly schemaVersion: number;
  readonly nodeCount: number;
  readonly taskCount: number;
  readonly baselineScore: number;
  readonly evaluator: readonly AblationRun[];
  readonly split: readonly SplitAblation[];
}

export function buildAblationStudy(input: {
  readonly nodes: readonly DiscoveryNode[];
  readonly evaluation: EvaluationInput;
  readonly splitConfig: EvaluationSplitConfig;
  readonly evaluatorConfig?: EvaluatorConfig;
}): AblationStudy {
  const baseline = input.evaluatorConfig ?? DEFAULT_EVALUATOR_CONFIG;
  return {
    schemaVersion: ABLATION_SCHEMA_VERSION,
    nodeCount: input.nodes.length,
    taskCount: new Set(input.nodes.map((node) => node.taskId)).size,
    baselineScore: evaluateReplay(input.evaluation, baseline).score,
    evaluator: ablateEvaluator(input.evaluation, baseline),
    split: ablateSplit(input.nodes, input.splitConfig)
  };
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
