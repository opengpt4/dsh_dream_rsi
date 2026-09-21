import type { JsonObject } from '../discovery/models.js';
import type { ActionResult, ActionStatus, EmbodiedActionType } from '../embodied/protocol.js';
import type { AuditSink } from '../registry/audit.js';
import { transition, terminalStateFor, type ActionState } from './action-state.js';
import {
  checkCapability,
  type CapabilityProfile,
  type CapabilityRejection,
  type RejectionCode
} from './capability.js';

/** Sliding window the per-session rate limit is measured over. */
export const RATE_WINDOW_MS = 60_000;

export interface GuardedActionRequest {
  readonly actionId: string;
  /** Repeated attempts at one logical action share this key. */
  readonly idempotencyKey: string;
  readonly sessionId: string;
  /** Absent for an interactive action taken through a tool rather than an episode. */
  readonly taskId?: string;
  readonly episodeId?: string;
  readonly correlationId: string;
  readonly actionType: EmbodiedActionType;
  readonly parameters: JsonObject;
  readonly frameId: string;
  readonly timeoutMs: number;
  readonly requestedAt: string;
  readonly confirmationToken?: string;
}

export interface ConfirmationRequest {
  readonly actionId: string;
  readonly sessionId: string;
  readonly actionType: EmbodiedActionType;
  readonly risk: string;
  readonly parameters: JsonObject;
  readonly token?: string;
}

export interface ActionRecord {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly episodeId?: string;
  /** Ties this record to the episode or tool call that requested it. */
  readonly correlationId: string;
  readonly actionType: EmbodiedActionType;
  readonly state: ActionState;
  /** Every state this action passed through, in order, starting at `REQUESTED`. */
  readonly history: readonly ActionState[];
  /** Present once the backend ran. Absent when the action was rejected. */
  readonly result?: ActionResult;
  readonly rejection?: CapabilityRejection;
}

export interface ActionGuardOptions {
  readonly profile: CapabilityProfile;
  readonly actionLeaseMs: number;
  readonly maxActionsPerMinute: number;
  readonly requireConfirmation: boolean;
  /** Approves a high-risk action. Absent means every high-risk action is denied. */
  readonly confirm?: (request: ConfirmationRequest) => boolean;
  /** Receives an `action.emergency-stop` event. An operator stop must be auditable. */
  readonly audit?: AuditSink;
  readonly now?: () => number;
}

interface MutableRecord {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly episodeId?: string;
  readonly correlationId: string;
  readonly actionType: EmbodiedActionType;
  state: ActionState;
  readonly history: ActionState[];
  result?: ActionResult;
  rejection?: CapabilityRejection;
}

/**
 * Enforces the action safety contract for one runtime: capability profile,
 * confirmation, per-session mutex and rate limit, idempotency, lease, and the
 * emergency-stop latch.
 *
 * Rejections are returned, never thrown, and are not cached under the
 * idempotency key: a rate-limited or busy rejection must be re-evaluated on the
 * next attempt, while an authorized action must never run twice.
 */
export class ActionGuard {
  private readonly records = new Map<string, MutableRecord>();
  private readonly idempotentActionIds = new Map<string, string>();
  private readonly stoppedSessions = new Map<string, string>();
  private readonly activeSessions = new Map<string, string>();
  private readonly dispatchTimes = new Map<string, number[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly stopping = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: ActionGuardOptions) {
    this.now = options.now ?? Date.now;
  }

  async execute(
    request: GuardedActionRequest,
    run: (signal: AbortSignal) => Promise<ActionResult>,
    signal?: AbortSignal
  ): Promise<ActionRecord> {
    // The stop latch is checked before the idempotency lookup: after an operator
    // stop, a previously recorded result must not be replayed as if it were a
    // successful retry.
    const stopReason = this.stoppedSessions.get(request.sessionId);
    if (stopReason !== undefined) {
      return this.reject(request, 'session_stopped', `session ${request.sessionId} is stopped: ${stopReason}`);
    }

    const recordedId = this.idempotentActionIds.get(request.idempotencyKey);
    if (recordedId !== undefined) return this.snapshot(this.records.get(recordedId)!);

    const activeId = this.activeSessions.get(request.sessionId);
    if (activeId !== undefined) {
      return this.reject(
        request,
        'session_busy',
        `session ${request.sessionId} is already executing ${activeId}`
      );
    }

    const check = checkCapability(this.options.profile, {
      actionType: request.actionType,
      frameId: request.frameId,
      parameters: request.parameters,
      timeoutMs: request.timeoutMs
    });
    if (!check.allowed) return this.reject(request, check.rejection.code, check.rejection.reason);

    if (this.options.requireConfirmation && check.capability.requiresConfirmation) {
      if (request.confirmationToken === undefined) {
        return this.reject(
          request,
          'confirmation_required',
          `${request.actionType} is ${check.capability.risk} risk and requires confirmation`
        );
      }
      const approved = this.options.confirm?.({
        actionId: request.actionId,
        sessionId: request.sessionId,
        actionType: request.actionType,
        risk: check.capability.risk,
        parameters: request.parameters,
        token: request.confirmationToken
      });
      if (approved !== true) {
        return this.reject(request, 'confirmation_denied', `confirmation for ${request.actionId} was denied`);
      }
    }

    const dispatchedAt = this.now();
    const recent = (this.dispatchTimes.get(request.sessionId) ?? []).filter(
      (time) => dispatchedAt - time < RATE_WINDOW_MS
    );
    if (recent.length >= this.options.maxActionsPerMinute) {
      return this.reject(
        request,
        'rate_limited',
        `session ${request.sessionId} reached ${this.options.maxActionsPerMinute} actions in ${RATE_WINDOW_MS}ms`
      );
    }

    const record: MutableRecord = {
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      actionType: request.actionType,
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.episodeId !== undefined ? { episodeId: request.episodeId } : {}),
      state: 'REQUESTED',
      history: ['REQUESTED']
    };
    this.records.set(request.actionId, record);
    this.idempotentActionIds.set(request.idempotencyKey, request.actionId);
    this.activeSessions.set(request.sessionId, request.actionId);
    this.advance(record, 'AUTHORIZED');

    // AUTHORIZED -> EXECUTING: the lease is acquired and the slot is occupied.
    this.advance(record, 'EXECUTING');
    recent.push(dispatchedAt);
    this.dispatchTimes.set(request.sessionId, recent);

    const controller = new AbortController();
    this.controllers.set(request.actionId, controller);
    let leaseExpired = false;
    const leaseTimer = setTimeout(() => {
      leaseExpired = true;
      controller.abort();
    }, this.options.actionLeaseMs);

    let result: ActionResult;
    try {
      const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
      result = await run(combined);
    } catch (error) {
      this.release(request.sessionId, request.actionId);
      this.advance(record, 'FAILED');
      record.rejection = {
        code: 'backend_error',
        reason: error instanceof Error ? error.message : String(error)
      };
      // Clear the stop marker on this path too. A throw is not a report — see
      // the precedence below — so the marker is never consulted again for this
      // action, and leaving it set would make the set stop meaning "an action
      // the guard interrupted".
      this.stopping.delete(request.actionId);
      return this.snapshot(record);
    } finally {
      clearTimeout(leaseTimer);
    }

    this.release(request.sessionId, request.actionId);

    // The guard owns the session-level deadline and the operator stop, so either
    // overrides the status the backend resolved with. A backend that throws
    // instead was handled above as `backend_error`: the adapter contract
    // requires an aborted call to resolve, so a rejection means the adapter is
    // unusable rather than that the guard's stop or lease was reported.
    const status: ActionStatus = this.stopping.has(request.actionId)
      ? 'emergency_stop'
      : leaseExpired
        ? 'timeout'
        : result.status;
    const settled: ActionResult = status === result.status
      ? result
      : {
          ...result,
          status,
          message: status === 'emergency_stop' ? 'action interrupted by emergency stop' : 'action lease expired',
          error: status === 'emergency_stop'
            ? `session ${request.sessionId} was stopped`
            : `action exceeded its ${this.options.actionLeaseMs}ms lease`
        };

    this.advance(record, terminalStateFor(status));
    record.result = settled;
    this.stopping.delete(request.actionId);
    return this.snapshot(record);
  }

  /**
   * Latch a session stopped and interrupt any action in flight.
   *
   * While the latch is set, `execute` refuses every request — including one
   * whose idempotency key was already recorded — so no automatic retry can
   * follow a stop.
   */
  emergencyStop(sessionId: string, reason: string): void {
    this.stoppedSessions.set(sessionId, reason);
    const activeId = this.activeSessions.get(sessionId);
    if (activeId !== undefined) {
      this.stopping.add(activeId);
      this.controllers.get(activeId)?.abort();
    }
    // Audited whether or not an action was in flight: the stop is the fact.
    this.options.audit?.record({
      type: 'action.emergency-stop',
      subject: 'session',
      subjectId: sessionId,
      correlationId: activeId ?? sessionId,
      reason,
      at: new Date(this.now()).toISOString()
    });
  }

  /** Clears the stop latch. Re-arming a stopped session is an explicit operator act. */
  releaseSession(sessionId: string): void {
    this.stoppedSessions.delete(sessionId);
  }

  /**
   * Drop every latch and slot.
   *
   * Disposal, not re-arming: the sessions this guard knew about belong to a
   * runtime that no longer exists, and a fresh runtime builds a fresh guard, so
   * nothing carries over that should not.
   */
  releaseAllSessions(): void {
    this.stoppedSessions.clear();
    this.activeSessions.clear();
    this.dispatchTimes.clear();
    this.stopping.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  isStopped(sessionId: string): boolean {
    return this.stoppedSessions.has(sessionId);
  }

  record(actionId: string): ActionRecord | undefined {
    const record = this.records.get(actionId);
    return record === undefined ? undefined : this.snapshot(record);
  }

  list(): ActionRecord[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  private release(sessionId: string, actionId: string): void {
    if (this.activeSessions.get(sessionId) === actionId) this.activeSessions.delete(sessionId);
    this.controllers.delete(actionId);
  }

  private advance(record: MutableRecord, to: ActionState): void {
    record.state = transition(record.state, to);
    record.history.push(record.state);
  }

  private reject(request: GuardedActionRequest, code: RejectionCode, reason: string): ActionRecord {
    return {
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      actionType: request.actionType,
      state: 'FAILED',
      history: ['REQUESTED', 'FAILED'],
      rejection: { code, reason },
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.episodeId !== undefined ? { episodeId: request.episodeId } : {})
    };
  }

  private snapshot(record: MutableRecord): ActionRecord {
    return {
      actionId: record.actionId,
      idempotencyKey: record.idempotencyKey,
      sessionId: record.sessionId,
      correlationId: record.correlationId,
      actionType: record.actionType,
      state: record.state,
      history: [...record.history],
      ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
      ...(record.episodeId !== undefined ? { episodeId: record.episodeId } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.rejection !== undefined ? { rejection: record.rejection } : {})
    };
  }
}
