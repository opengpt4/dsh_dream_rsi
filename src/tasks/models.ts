import type { JsonObject } from '../discovery/models.js';

/**
 * Terminal episode states. `running` is the only non-terminal value.
 *
 * `emergency_stop` is distinct from `cancelled`: an operator stop forbids
 * automatic retry, a cancellation does not.
 */
export type EpisodeStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'emergency_stop';

/** Hard ceilings one episode may consume before it is stopped by the runner. */
export interface ResourceBudget {
  /** Maximum environment steps one episode may take. */
  readonly maxSteps: number;
  /** Wall-clock ceiling for the whole episode, checked between steps. */
  readonly wallClockMs: number;
}

export interface Task {
  readonly taskId: string;
  readonly goal: string;
  readonly environmentId: string;
  /**
   * Policy version pinned at task start. A later deployment must not mutate the
   * policy an already-running episode is executing.
   */
  readonly policyVersion: string;
  readonly budget: ResourceBudget;
  readonly metadata: JsonObject;
}

export interface Episode {
  readonly episodeId: string;
  readonly taskId: string;
  /** Environment session this episode owns exclusively. */
  readonly sessionId: string;
  readonly environmentId: string;
  readonly policyVersion: string;
  /** Steps completed, i.e. actions that reached a terminal result. */
  readonly step: number;
  readonly status: EpisodeStatus;
  /** Ties every node, action, and event of this episode to one trace. */
  readonly correlationId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
}

export function validateTask(task: Task): void {
  if (task.taskId.trim().length === 0) throw new Error('task.taskId must not be empty');
  if (task.environmentId.trim().length === 0) throw new Error('task.environmentId must not be empty');
  if (task.policyVersion.trim().length === 0) throw new Error('task.policyVersion must not be empty');
  if (!Number.isInteger(task.budget.maxSteps) || task.budget.maxSteps <= 0) {
    throw new Error('task.budget.maxSteps must be a positive integer');
  }
  if (!Number.isFinite(task.budget.wallClockMs) || task.budget.wallClockMs <= 0) {
    throw new Error('task.budget.wallClockMs must be positive');
  }
}
