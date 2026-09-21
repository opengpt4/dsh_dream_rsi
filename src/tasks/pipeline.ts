import { assertArtifactsVerified, type ArtifactStore } from '../artifacts/store.js';
import { assertCandidateAccepted, type CandidateGateOptions } from '../guardrails/candidate-gate.js';
import {
  createEvaluationReport,
  type CaseResult,
  type EvaluationReport,
  type GuardResult
} from '../registry/models.js';
import type { PolicyRegistry } from '../registry/policy-registry.js';
import type { MetricsSink } from '../observability/metrics.js';
import type { DiscoveryNode } from '../discovery/models.js';
import {
  evaluateReplay,
  type EvaluationInput,
  type EvaluationResult,
  type EvaluatorConfig
} from '../evolution/evaluator.js';
import { evaluateReplayIsolated } from '../evolution/isolated-evaluator.js';
import { createEvaluationSnapshot, type EvaluationSnapshot } from '../evolution/snapshot.js';
import { DEFAULT_SPLIT_CONFIG, type EvaluationSplitConfig, type EvaluationSplitName } from '../evolution/split.js';
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
  /** Present when the caller supplied a registry to report to. */
  readonly report?: EvaluationReport;
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
  /**
   * `episode` snapshots the nodes this run just recorded; `store` snapshots the
   * whole persisted tree, read in one transaction. The default keeps a
   * single-episode run independent of whatever else the store holds.
   */
  readonly snapshotSource?: 'episode' | 'store';
  /** Verified before evaluation; any artifact that fails stops the run. */
  readonly artifacts?: {
    readonly store: ArtifactStore;
    readonly artifactIds: readonly string[];
  };
  /** Scanned before evaluation; a candidate that trips either guard stops the run. */
  readonly candidateSource?: CandidateGateOptions;
  /** Receives correlation-tagged samples for this run. */
  readonly metrics?: MetricsSink;
  /**
   * Persist an evaluation report for this run.
   *
   * The policy artifact must already be registered, because a score is only
   * meaningful against a policy whose source is known.
   */
  readonly reporting?: {
    readonly registry: PolicyRegistry;
    readonly policyArtifactId: string;
    readonly evaluatorVersion: string;
    readonly sourceHash: string;
    readonly configHash: string;
    readonly split: EvaluationSplitName;
    readonly taskFamily: string;
  };
}

/**
 * One episode end to end: perceive, act, record a Discovery node per step,
 * snapshot the tree, replay it, and score it.
 */
export async function runEpisodePipeline(options: EpisodePipelineOptions): Promise<EpisodePipelineResult> {
  const settings: EpisodePipelineSettings = { ...DEFAULT_EPISODE_PIPELINE_SETTINGS, ...options.settings };
  // Fail closed before spending any work: an artifact whose checksum does not
  // match its name must never be scored, and a candidate that trips a guard
  // must never run at all.
  if (options.artifacts !== undefined) {
    assertArtifactsVerified(options.artifacts.store, options.artifacts.artifactIds);
  }
  if (options.candidateSource !== undefined) {
    assertCandidateAccepted(options.candidateSource);
  }

  const outcome = await runEpisode(options);
  const nodes = options.snapshotSource === 'store' ? options.store.readAll() : outcome.nodes;
  const snapshot = createEvaluationSnapshot(nodes, options.splitConfig ?? DEFAULT_SPLIT_CONFIG);
  const { report } = replayNodes(nodes, settings);
  const evaluationInput = toEvaluationInput(nodes, report);
  const evaluate = options.evaluate
    ?? (options.isolated === true
      ? createIsolatedEvaluation(settings.evaluatorTimeoutMs, options.evaluatorConfig)
      : (input: EvaluationInput) => Promise.resolve(evaluateReplay(input, options.evaluatorConfig)));
  const evaluation = await evaluate(evaluationInput);

  const missRate = report.replayedNodeIds.length === 0
    ? 0
    : report.missCount / report.replayedNodeIds.length;
  const holdoutSampleCount = snapshot.splits.holdout.length;

  const gates: EpisodeGates = {
    missRate,
    missRateWithinBudget: missRate <= settings.missRateMax,
    holdoutSampleCount,
    holdoutSufficient: holdoutSampleCount >= settings.minimumHoldoutSamples
  };

  const evaluationReport = options.reporting === undefined
    ? undefined
    : buildReport(options.reporting, outcome, snapshot, evaluation, report, gates, settings.missRateMax);

  recordRunMetrics(options, outcome, evaluation, report, evaluationReport);

  return {
    outcome,
    snapshot,
    replay: report,
    evaluationInput,
    evaluation,
    gates,
    ...(evaluationReport !== undefined ? { report: evaluationReport } : {})
  };
}

/**
 * Record what this run produced, tagged so a sample can be traced to its run.
 *
 * A run without a metrics sink records nothing rather than silently discarding.
 */
function recordRunMetrics(
  options: EpisodePipelineOptions,
  outcome: EpisodeOutcome,
  evaluation: EvaluationResult,
  replay: ReplayReport,
  report: EvaluationReport | undefined
): void {
  const metrics = options.metrics;
  if (metrics === undefined) return;

  const labels = {
    taskId: options.task.taskId,
    episodeId: outcome.episode.episodeId,
    policyVersion: options.task.policyVersion,
    ...(options.reporting?.taskFamily !== undefined ? { taskFamily: options.reporting.taskFamily } : {}),
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(report !== undefined ? { evaluationId: report.evaluationId } : {})
  };

  metrics.record('task.outcome', outcome.episode.status === 'completed' ? 1 : 0, {
    ...labels,
    outcome: outcome.episode.status
  });
  metrics.record('episode.stepCount', outcome.episode.step, labels);
  metrics.record('episode.durationMs', Date.parse(outcome.episode.endedAt ?? outcome.episode.startedAt) - Date.parse(outcome.episode.startedAt), labels);
  metrics.record('evaluation.quality', evaluation.quality, labels);
  metrics.record('evaluation.cost', evaluation.cost, labels);
  metrics.record('evaluation.parallelEfficiency', evaluation.parallelEfficiency, labels);
  metrics.record('evaluation.missRate', evaluation.missRate, labels);
  metrics.record('evaluation.score', evaluation.score, labels);
  if (replay.hitCount > 0) metrics.record('replay.hit', replay.hitCount, labels);
  if (replay.missCount > 0) metrics.record('replay.miss', replay.missCount, labels);
}

/**
 * One episode is one case. The case list is a list because the benchmark
 * (step 13) evaluates many tasks; a single-episode run reports a single sample
 * rather than presenting one observation as a distribution.
 */
function buildReport(
  reporting: NonNullable<EpisodePipelineOptions['reporting']>,
  outcome: EpisodeOutcome,
  snapshot: EvaluationSnapshot,
  evaluation: EvaluationResult,
  replay: ReplayReport,
  gates: EpisodeGates,
  missRateMax: number
): EvaluationReport {
  const episode = outcome.episode;
  const caseResults: CaseResult[] = [
    {
      caseId: episode.episodeId,
      taskFamily: reporting.taskFamily,
      split: reporting.split,
      outcome: episode.status === 'completed' ? 'passed' : 'failed',
      // One episode is one case, so the case metrics are the episode's metrics.
      quality: evaluation.quality,
      score: evaluation.score,
      cost: evaluation.cost,
      latencyMs: Date.parse(episode.endedAt ?? episode.startedAt) - Date.parse(episode.startedAt),
      missed: replay.missCount > 0,
      ...(episode.status === 'completed' ? {} : { reason: outcome.cause ?? episode.status })
    }
  ];

  const guardResults: GuardResult[] = [
    {
      guard: 'replayMissRateBudget',
      passed: gates.missRateWithinBudget,
      detail: `missRate ${gates.missRate} against limit ${missRateMax}`
    },
    {
      guard: 'holdoutSamples',
      passed: gates.holdoutSufficient,
      detail: `${gates.holdoutSampleCount} holdout nodes`
    }
  ];

  const report = createEvaluationReport({
    evaluatorVersion: reporting.evaluatorVersion,
    sourceHash: reporting.sourceHash,
    snapshotId: snapshot.snapshotId,
    policyArtifactId: reporting.policyArtifactId,
    split: reporting.split,
    configHash: reporting.configHash,
    metrics: {
      quality: evaluation.quality,
      cost: evaluation.cost,
      parallelEfficiency: evaluation.parallelEfficiency,
      missRate: evaluation.missRate,
      score: evaluation.score
    },
    caseResults,
    sampleCount: outcome.nodes.length,
    passed: gates.missRateWithinBudget && episode.status === 'completed',
    guardResults
  });
  reporting.registry.registerEvaluation(report);
  return report;
}

