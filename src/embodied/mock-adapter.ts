import { MockEmbodiedBackend } from './backend.js';
import {
  EMBODIED_ACTION_TYPES,
  OBSERVATION_SCHEMA_VERSION,
  type ActionRequest,
  type ActionResult,
  type EmbodiedActionType,
  type EnvironmentAdapter,
  type Observation,
  type ObserveRequest
} from './protocol.js';

export const MOCK_ENVIRONMENT_ID = 'mock-room-v1';
export const MOCK_ENVIRONMENT_VERSION = `${MOCK_ENVIRONMENT_ID}@1`;
export const MOCK_FRAME_ID = `${MOCK_ENVIRONMENT_ID}/world`;

/**
 * Adapts the mock simulator SDK to {@link EnvironmentAdapter}.
 *
 * Owns everything the SDK does not: identifier mapping, the coordinate frame,
 * schema version, deadline enforcement, and the operator stop latch. Callers
 * never see a thrown action error — every attempt resolves to a terminal
 * {@link ActionResult} so the caller records rather than catches.
 */
export class MockEnvironmentAdapter implements EnvironmentAdapter {
  private readonly stoppedSessions = new Set<string>();

  constructor(private readonly backend = new MockEmbodiedBackend()) {}

  async observe(request: ObserveRequest): Promise<Observation> {
    const raw = this.backend.observe(request.sessionId);
    return {
      sessionId: raw.sessionId,
      environmentId: MOCK_ENVIRONMENT_ID,
      environmentVersion: MOCK_ENVIRONMENT_VERSION,
      frameId: MOCK_FRAME_ID,
      step: raw.step,
      pose: { ...raw.pose },
      gripper: raw.gripper,
      objects: request.includeObjects
        ? raw.objects.map((object) => ({
            id: object.id,
            label: object.label,
            position: [object.position[0], object.position[1], object.position[2]] as const
          }))
        : [],
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      timestamp: raw.timestamp
    };
  }

  async availableActions(): Promise<readonly EmbodiedActionType[]> {
    return EMBODIED_ACTION_TYPES;
  }

  async execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    const startedAt = Date.now();
    const finish = (
      status: ActionResult['status'],
      message: string,
      extra: { readonly error?: string; readonly step?: number; readonly pose?: Observation['pose']; readonly gripper?: Observation['gripper'] } = {}
    ): ActionResult => {
      const current = this.backend.observe(request.sessionId);
      return {
        actionId: request.actionId,
        status,
        step: extra.step ?? current.step,
        pose: extra.pose ?? { ...current.pose },
        gripper: extra.gripper ?? current.gripper,
        message,
        execTimeMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
        ...(extra.error !== undefined ? { error: extra.error } : {})
      };
    };

    if (!EMBODIED_ACTION_TYPES.includes(request.actionType)) {
      return finish('failed', `unknown action type ${request.actionType}`, {
        error: `action ${request.actionType} is not in the capability profile`
      });
    }
    // A stopped session is latched: no attempt may proceed until an explicit reset.
    if (this.stoppedSessions.has(request.sessionId)) {
      return finish('emergency_stop', 'session is stopped', { error: 'emergency stop is latched for this session' });
    }
    if (signal?.aborted) {
      return finish('cancelled', 'cancelled before execution', { error: 'action cancelled before execution' });
    }

    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);

    try {
      const raw = await this.backend.execute(
        request.sessionId,
        request.actionType,
        { ...request.parameters },
        controller.signal
      );
      return finish('completed', raw.message, { step: raw.step, pose: raw.pose, gripper: raw.gripper });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (timedOut) return finish('timeout', 'action timed out', { error: `deadline ${request.timeoutMs}ms exceeded` });
      if (signal?.aborted) return finish('cancelled', 'action cancelled', { error: message });
      return finish('failed', 'action failed', { error: message });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async emergencyStop(sessionId: string): Promise<void> {
    this.stoppedSessions.add(sessionId);
  }

  reset(sessionId: string): void {
    this.stoppedSessions.delete(sessionId);
    this.backend.reset(sessionId);
  }
}
