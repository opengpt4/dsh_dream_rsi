import { canonicalJson } from '../hash.js';

/**
 * Correlation-aware metrics.
 *
 * Every sample carries the identifiers that tie it to a task, episode, policy,
 * evaluation, or deployment, so a number can always be traced back to the run
 * that produced it rather than only being aggregable.
 */

export type MetricName =
  | 'task.outcome'
  | 'episode.stepCount'
  | 'episode.durationMs'
  | 'evaluation.quality'
  | 'evaluation.cost'
  | 'evaluation.parallelEfficiency'
  | 'evaluation.missRate'
  | 'evaluation.score'
  | 'replay.hit'
  | 'replay.miss'
  | 'action.failure'
  | 'action.emergencyStop'
  | 'action.rateLimited'
  | 'evolution.candidateRejected'
  | 'policy.deployment'
  | 'policy.rollback'
  | 'artifact.verificationFailure'
  | 'llm.inputTokens'
  | 'llm.outputTokens'
  | 'llm.latencyMs'
  | 'llm.retry'
  | 'llm.failure';

export interface MetricLabels {
  readonly taskId?: string;
  readonly episodeId?: string;
  readonly policyVersion?: string;
  readonly policyArtifactId?: string;
  readonly evaluationId?: string;
  readonly deploymentId?: string;
  readonly correlationId?: string;
  readonly taskFamily?: string;
  readonly outcome?: string;
}

export interface MetricSample {
  readonly name: MetricName;
  readonly value: number;
  readonly labels: MetricLabels;
  readonly at: string;
}

export interface MetricSummary {
  readonly name: MetricName;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly total: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

export interface MetricsSink {
  record(name: MetricName, value: number, labels?: MetricLabels): void;
}

export interface MetricsReader {
  list(): readonly MetricSample[];
  summary(): readonly MetricSummary[];
}

export class InMemoryMetrics implements MetricsSink, MetricsReader {
  private readonly samples: MetricSample[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(name: MetricName, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) throw new Error(`metric ${name} must be finite, received ${value}`);
    this.samples.push({ name, value, labels: prune(labels), at: this.now().toISOString() });
  }

  /** Convenience for a count of one. */
  count(name: MetricName, labels: MetricLabels = {}): void {
    this.record(name, 1, labels);
  }

  list(): readonly MetricSample[] {
    return this.samples.map((sample) => ({ ...sample, labels: { ...sample.labels } }));
  }

  /** Totals per metric and label set, ordered so two runs produce the same report. */
  summary(): readonly MetricSummary[] {
    const groups = new Map<string, { name: MetricName; labels: MetricLabels; values: number[] }>();
    for (const sample of this.samples) {
      const key = groupKey(sample.name, sample.labels);
      const group = groups.get(key) ?? { name: sample.name, labels: sample.labels, values: [] };
      group.values.push(sample.value);
      groups.set(key, group);
    }

    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, group]) => ({
        name: group.name,
        labels: group.labels,
        count: group.values.length,
        total: group.values.reduce((sum, value) => sum + value, 0),
        min: Math.min(...group.values),
        max: Math.max(...group.values),
        mean: group.values.reduce((sum, value) => sum + value, 0) / group.values.length
      }));
  }

  /** Total for one metric and label set, or zero when nothing was recorded. */
  total(name: MetricName, labels: MetricLabels = {}): number {
    const key = groupKey(name, prune(labels));
    return this.samples
      .filter((sample) => groupKey(sample.name, sample.labels) === key)
      .reduce((sum, sample) => sum + sample.value, 0);
  }
}

/** Label sets are compared canonically, so key order never splits a group. */
function groupKey(name: MetricName, labels: MetricLabels): string {
  return `${name}\u0000${canonicalJson(labels as never)}`;
}

function prune(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(Object.entries(labels).filter(([, value]) => value !== undefined)) as MetricLabels;
}
