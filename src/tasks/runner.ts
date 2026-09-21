import {
  DISCOVERY_NODE_SCHEMA_VERSION,
  type DiscoveryNode,
  type DiscoveryStore,
  type JsonObject,
  type JsonValue
} from '../discovery/models.js';
import { hashEnvironmentState, hashObservation } from '../embodied/hash.js';
import {
  assertObservationSchema,
  type ActionRequest,
  type ActionResult,
  type EmbodiedActionType,
  type EnvironmentAdapter,
  type Observation
} from '../embodied/protocol.js';
import type { ActionGuard } from '../safety/action-guard.js';
import { validateTask, type Episode, type EpisodeStatus, type Task } from './models.js';

export interface PolicyAction {
  readonly actionType: EmbodiedActionType;
  readonly parameters: JsonObject;
  readonly timeoutMs?: number;
  /** Model tokens this decision cost. A scripted mock policy spends none. */
  readonly tokenCost?: number;
  /** Presented to the guard for actions whose capability requires confirmation. */
  readonly confirmationToken?: string;
}

export interface PolicyDecisionContext {
  /** Steps already recorded for this episode. */
  readonly step: number;
  /** State the decision is made from, before the action runs. */
  readonly observation: Observation;
  readonly history: readonly DiscoveryNode[];
}

/**
 * Returns the next action, or `null` to concede the episode.
 *
 * The policy may not mutate `observation` or `history`; both are the recorded
 * facts a replay key is derived from.
 */
export type Policy = (context: PolicyDecisionContext) => PolicyAction | null;

/** Replays a fixed action list, one action per step. */
export function planPolicy(actions: readonly PolicyAction[]): Policy {
  return ({ step }) => actions[step] ?? null;
}

export interface RunEpisodeOptions {
  readonly task: Task;
  readonly episodeId: string;
  readonly sessionId: string;
  readonly adapter: EnvironmentAdapter;
  readonly store: DiscoveryStore;
  readonly policy: Policy;
  /** Defaults to `episodeId`, so one episode is one trace. */
  readonly correlationId?: string;
  /** Quality of one recorded step, used as the node score. Defaults to 0. */
  readonly scoreStep?: (observation: Observation, result: ActionResult) => number;
  readonly isGoalReached?: (observation: Observation) => boolean;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
  /**
   * Operator stop. Checked before every action and again before every execute;
   * on trip the adapter's session is latched stopped and no further action runs.
   */
  readonly emergencyStop?: AbortSignal;
  readonly defaultActionTimeoutMs?: number;
  /**
   * When present, every action is authorized, leased, rate-limited, and
   * idempotency-checked before the backend sees it. Absent means the adapter is
   * called directly, which is how the recorded fixtures exercise the raw path.
   */
  readonly guard?: ActionGuard;
}

export interface EpisodeOutcome {
  readonly episode: Episode;
  readonly nodes: readonly DiscoveryNode[];
  /** Why a terminal episode ended. Absent when the goal was reached. */
  readonly cause?: string;
}

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

/**
 * Run one episode to a terminal state.
 *
 * Every step records exactly one Discovery node, including failed, timed-out,
 * and cancelled attempts: a negative result is evidence, and dropping it would
 * make the recorded tree disagree with what the environment actually did.
 */
export async function runEpisode(options: RunEpisodeOptions): Promise<EpisodeOutcome> {
  const { task, episodeId, sessionId, adapter, store, policy } = options;
  validateTask(task);

  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + task.budget.wallClockMs;
  const startedAt = new Date(startedAtMs).toISOString();
  const correlationId = options.correlationId ?? episodeId;

  const nodes: DiscoveryNode[] = [];
  let parentId: string | null = null;
  let criticalPathMs = 0;

  // Tests the loop condition through calls, not a cached read: the policy runs
  // arbitrary host code between checks and may abort either controller itself.
  const stopRequested = (): boolean => options.emergencyStop?.aborted === true;
  const cancelled = (): boolean => options.signal?.aborted === true;

  const conclude = async (next: EpisodeStatus, why?: string): Promise<EpisodeOutcome> => {
    if (next === 'emergency_stop') {
      await adapter.emergencyStop(sessionId);
      // Latch the guard too, so the stop outlives this episode: a later episode
      // reusing the session must be refused rather than silently proceeding.
      options.guard?.emergencyStop(sessionId, why ?? 'episode ended in emergency stop');
    }
    const episode: Episode = {
      episodeId,
      taskId: task.taskId,
      sessionId,
      environmentId: task.environmentId,
      policyVersion: task.policyVersion,
      step: nodes.length,
      status: next,
      correlationId,
      startedAt,
      endedAt: new Date().toISOString()
    };
    return why === undefined ? { episode, nodes } : { episode, nodes, cause: why };
  };

  while (true) {
    if (stopRequested()) return conclude('emergency_stop', 'emergency stop requested');
    if (cancelled()) return conclude('cancelled', 'episode cancelled');
    if (Date.now() >= deadlineMs) return conclude('timeout', 'wall-clock budget exhausted');

    const observation = await adapter.observe({ sessionId, correlationId, includeObjects: true });

    // A version mismatch would otherwise reach the replay key and produce a
    // silently different key rather than an error, which is the one thing a
    // version field exists to prevent.
    try {
      assertObservationSchema(observation);
    } catch (error) {
      return conclude('failed', error instanceof Error ? error.message : String(error));
    }

    if (observation.environmentId !== task.environmentId) {
      return conclude(
        'failed',
        `task is bound to ${task.environmentId} but the environment reported ${observation.environmentId}`
      );
    }
    if (options.isGoalReached?.(observation) === true) return conclude('completed');
    if (nodes.length >= task.budget.maxSteps) return conclude('failed', 'step budget exhausted');

    const decision = policy({ step: nodes.length, observation, history: nodes });
    if (decision === null) return conclude('failed', 'policy exhausted its plan without reaching the goal');

    if (stopRequested()) return conclude('emergency_stop', 'emergency stop requested');
    if (cancelled()) return conclude('cancelled', 'episode cancelled');

    const remainingMs = deadlineMs - Date.now();    if (remainingMs <= 0) return conclude('timeout', 'wall-clock budget exhausted');
    const timeoutMs = Math.max(
      1,
      Math.min(decision.timeoutMs ?? options.defaultActionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, remainingMs)
    );

    const actionId = `${episodeId}:${nodes.length}`;
    const request: ActionRequest = {
      actionId,
      sessionId,
      taskId: task.taskId,
      episodeId,
      correlationId,
      actionType: decision.actionType,
      parameters: decision.parameters,
      timeoutMs,
      requestedAt: new Date().toISOString()
    };
    const result = await dispatch(request, observation, options, decision.confirmationToken);
    criticalPathMs += result.execTimeMs;

    const node: DiscoveryNode = {
      nodeId: actionId,
      taskId: task.taskId,
      parentId,
      policyVersion: task.policyVersion,
      environmentVersion: observation.environmentVersion,
      stateHash: hashEnvironmentState(observation),
      observationHash: hashObservation(observation),
      actionType: decision.actionType,
      actionParams: decision.parameters,
      result: toJsonValue(result),
      score: options.scoreStep?.(observation, result) ?? 0,
      tokenCost: decision.tokenCost ?? 0,
      execTimeMs: result.execTimeMs,
      criticalPathMs,
      sessionId,
      episodeId,
      episodeStep: nodes.length,
      correlationId,
      // Retrying one logical step must return the node already recorded for it.
      idempotencyKey: actionId,
      schemaVersion: DISCOVERY_NODE_SCHEMA_VERSION,
      createdAt: result.completedAt
    };
    nodes.push(store.append(node));
    parentId = node.nodeId;

    if (result.status !== 'completed') {
      return conclude(result.status, result.error ?? result.message);
    }
  }
}

/**
 * Put one action through the guard when one is configured.
 *
 * A rejection is a recorded outcome, not an exception: the node still needs a
 * terminal result, so one is synthesized from the observation the decision was
 * made from.
 */
async function dispatch(
  request: ActionRequest,
  observation: Observation,
  options: RunEpisodeOptions,
  confirmationToken: string | undefined
): Promise<ActionResult> {
  if (options.guard === undefined) return options.adapter.execute(request, options.signal);

  const record = await options.guard.execute(
    {
      actionId: request.actionId,
      // One logical action is one step of one episode, so a retry of that step
      // resolves to the result already recorded for it.
      idempotencyKey: request.actionId,
      sessionId: request.sessionId,
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.episodeId !== undefined ? { episodeId: request.episodeId } : {}),
      correlationId: request.correlationId,
      actionType: request.actionType,
      parameters: request.parameters,
      frameId: observation.frameId,
      timeoutMs: request.timeoutMs,
      requestedAt: request.requestedAt,
      ...(confirmationToken !== undefined ? { confirmationToken } : {})
    },
    (signal) => options.adapter.execute(request, signal),
    options.signal
  );
  if (record.result !== undefined) return record.result;

  const reason = record.rejection?.reason ?? 'action was not authorized';
  return {
    actionId: request.actionId,
    status: 'failed',
    step: observation.step,
    pose: { ...observation.pose },
    gripper: observation.gripper,
    message: reason,
    execTimeMs: 0,
    completedAt: new Date().toISOString(),
    error: record.rejection === undefined ? reason : `${record.rejection.code}: ${reason}`
  };
}

function toJsonValue(result: ActionResult): JsonValue {
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}
