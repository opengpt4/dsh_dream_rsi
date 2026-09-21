import type { DiscoveryNode } from '../discovery/models.js';
import {
  evaluateReplay,
  type EvaluationInput,
  type EvaluationResult,
  type EvaluatorConfig
} from '../evolution/evaluator.js';
import { evaluateReplayIsolated } from '../evolution/isolated-evaluator.js';
import { createEvaluationSnapshot, type EvaluationSnapshot } from '../evolution/snapshot.js';
import { DEFAULT_SPLIT_CONFIG, type EvaluationSplitConfig } from '../evolution/split.js';
import { replayKeyInputFromNode } from '../replay/key.js';
import { ReplaySimulator } from '../replay/simulator.js';
import { runEpisode, type EpisodeOutcome, type RunEpisodeOptions } from './runner.js';

/** Runtime-derived ceilings the episode pipeline enforces. */
export interface EpisodePipelineSettings {
  /** Nodes replayed from an episode; the remainder is reported, not dropped silently. */
  readonly replayMaxNodes: number;
  /** Fraction of replay attempts that may miss before the episode is flagged. */
  readonly missRateMax: number;
  /** Deadline handed to the isolated evaluator. */
  readonly evaluatorTimeoutMs: number;
  /** Holdout nodes required before a score may be treated as generalizing. */
  readonly minimumHoldoutSamples: number;
}

export const DEFAULT_EPISODE_PIPELINE_SETTINGS: EpisodePipelineSettings = {
  replayMaxNodes: 10_000,
  missRateMax: 0.05,
  evaluatorTimeoutMs: 5_000,
  minimumHoldoutSamples: 20
};

/**
 * Fold a runtime's derived settings into pipeline settings.
 *
 * Structurally typed so the runtime does not have to depend on this module.
 */
export function pipelineSettings(source: {
  readonly replaySettings: { readonly maxNodes: number; readonly missRateMax: number };
  readonly evaluationSettings: { readonly timeoutMs: number; readonly minimumHoldoutSamples: number };
}): EpisodePipelineSettings {
  return {
    replayMaxNodes: source.replaySettings.maxNodes,
    missRateMax: source.replaySettings.missRateMax,
    evaluatorTimeoutMs: source.evaluationSettings.timeoutMs,
    minimumHoldoutSamples: source.evaluationSettings.minimumHoldoutSamples
  };
}

export interface BoundaryMiss {
  readonly replayKey: string;
  readonly availableActionTypes: readonly string[];
}

export interface ReplayReport {
  readonly hitCount: number;
  readonly missCount: number;
  readonly visitedNodeIds: readonly string[];
  readonly boundaryMisses: readonly BoundaryMiss[];
  /** Nodes whose decision was re-issued. */
  readonly replayedNodeIds: readonly string[];
  /** Nodes past `replayMaxNodes`, excluded from this replay. */
  readonly deferredNodeIds: readonly string[];
}

export interface EpisodeGates {
  readonly missRate: number;
  readonly missRateWithinBudget: boolean;
  readonly holdoutSampleCount: number;
  readonly holdoutSufficient: boolean;
}

export interface EpisodeReplay {
  /** Exposed so a caller can probe a decision the episode never recorded. */
  readonly simulator: ReplaySimulator;
  readonly report: ReplayReport;
}

export interface EpisodePipelineResult {
  readonly outcome: EpisodeOutcome;
  readonly snapshot: EvaluationSnapshot;
  readonly replay: ReplayReport;
  readonly evaluationInput: EvaluationInput;
  readonly evaluation: EvaluationResult;
  readonly gates: EpisodeGates;
}

/**
 * Replay an episode's recorded decisions through a simulator built from the
 * same nodes.
 *
 * This is a determinism check, not generalization evidence: every replayed
 * decision was recorded from the state it is replayed against, so a clean run
 * proves the replay key is stable and the state index resolves. Generalization
 * needs holdout tasks the policy never saw, which the multi-task benchmark
 * (still an open release blocker) is what produces.
 */
export function replayNodes(
  nodes: readonly DiscoveryNode[],
  settings: Pick<EpisodePipelineSettings, 'replayMaxNodes'> = DEFAULT_EPISODE_PIPELINE_SETTINGS
): EpisodeReplay {
  if (!Number.isInteger(settings.replayMaxNodes) || settings.replayMaxNodes <= 0) {
    throw new Error('replayMaxNodes must be a positive integer');
  }

  const replayed = nodes.slice(0, settings.replayMaxNodes);
  const deferredNodeIds = nodes.slice(settings.replayMaxNodes).map((node) => node.nodeId);
  const simulator = new ReplaySimulator(replayed);
  const boundaryMisses: BoundaryMiss[] = [];

  for (const node of replayed) {
    const result = simulator.execute(replayKeyInputFromNode(node));
    if (result.kind === 'boundary_miss') {
      boundaryMisses.push({ replayKey: result.replayKey, availableActionTypes: result.availableActionTypes });
    }
  }

  const metrics = simulator.metrics();
  return {
    simulator,
    report: {
      hitCount: metrics.hitCount,
      missCount: metrics.missCount,
      visitedNodeIds: metrics.visitedNodeIds,
      boundaryMisses,
      replayedNodeIds: replayed.map((node) => node.nodeId),
      deferredNodeIds
    }
  };
}

/**
 * The production evaluation path: the evaluator runs in a child process so a
 * candidate cannot reach holdout data or secrets through shared memory.
 */
export function createIsolatedEvaluation(
  timeoutMs: number,
  config?: EvaluatorConfig
): (input: EvaluationInput) => Promise<EvaluationResult> {
  return (input) => evaluateReplayIsolated(input, config, { timeoutMs });
}

function toEvaluationInput(nodes: readonly DiscoveryNode[], report: ReplayReport): EvaluationInput {
  const visitedNodeIds = new Set(report.visitedNodeIds);
  const visitedNodes = nodes.filter((node) => visitedNodeIds.has(node.nodeId));
  const totalExecTime = nodes.reduce((total, node) => total + node.execTimeMs, 0);
  const maxCriticalPath = nodes.reduce((max, node) => Math.max(max, node.criticalPathMs ?? 0), 0);

  return {
    visitedNodes,
    boundaryMissCount: report.missCount,
    totalAttempts: report.replayedNodeIds.length,
    // A sequential episode has no parallelism to exploit, so critical path and
    // total exec time coincide; the floor keeps the ratio defined for an empty
    // or instantaneous episode.
    criticalPathMs: Math.max(maxCriticalPath, totalExecTime, 1)
  };
}

export interface EpisodePipelineOptions extends RunEpisodeOptions {
  readonly evaluatorConfig?: EvaluatorConfig;
  readonly splitConfig?: EvaluationSplitConfig;
  readonly settings?: Partial<EpisodePipelineSettings>;
  /**
   * Run the evaluator in a child process. Defaults to in-process, which is
   * sufficient for a recorded episode and keeps the mock path free of process
   * spawns.
   */
  readonly isolated?: boolean;
  /** Overrides the evaluator entirely, e.g. to inject a failing one. */
  readonly evaluate?: (input: EvaluationInput) => Promise<EvaluationResult>;
}

/**
 * One episode end to end: perceive, act, record a Discovery node per step,
 * snapshot the tree, replay it, and score it.
 */
export async function runEpisodePipeline(options: EpisodePipelineOptions): Promise<EpisodePipelineResult> {
  const settings: EpisodePipelineSettings = { ...DEFAULT_EPISODE_PIPELINE_SETTINGS, ...options.settings };
  const outcome = await runEpisode(options);
  const snapshot = createEvaluationSnapshot(outcome.nodes, options.splitConfig ?? DEFAULT_SPLIT_CONFIG);
  const { report } = replayNodes(outcome.nodes, settings);
  const evaluationInput = toEvaluationInput(outcome.nodes, report);
  const evaluate = options.evaluate
    ?? (options.isolated === true
      ? createIsolatedEvaluation(settings.evaluatorTimeoutMs, options.evaluatorConfig)
      : (input: EvaluationInput) => Promise.resolve(evaluateReplay(input, options.evaluatorConfig)));
  const evaluation = await evaluate(evaluationInput);

  const missRate = report.replayedNodeIds.length === 0
    ? 0
    : report.missCount / report.replayedNodeIds.length;
  const holdoutSampleCount = snapshot.splits.holdout.length;

  return {
    outcome,
    snapshot,
    replay: report,
    evaluationInput,
    evaluation,
    gates: {
      missRate,
      missRateWithinBudget: missRate <= settings.missRateMax,
      holdoutSampleCount,
      holdoutSufficient: holdoutSampleCount >= settings.minimumHoldoutSamples
    }
  };
}
