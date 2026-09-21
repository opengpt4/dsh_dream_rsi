import type { EmbodiedActionType, GripperState, Pose } from './protocol.js';

export interface MockObject {
  readonly id: string;
  readonly label: string;
  readonly position: readonly [number, number, number];
}

export interface MockObservation {
  readonly sessionId: string;
  readonly environmentId: 'mock-room-v1';
  readonly step: number;
  readonly pose: Pose;
  readonly gripper: GripperState;
  readonly objects: readonly MockObject[];
  readonly timestamp: string;
}

interface MutablePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface SessionState {
  step: number;
  pose: MutablePose;
  gripper: GripperState;
}

export type { EmbodiedActionType };

export interface MockActionResult {
  readonly actionType: EmbodiedActionType;
  readonly step: number;
  readonly pose: Pose;
  readonly gripper: GripperState;
  readonly message: string;
}

export class MockEmbodiedBackend {
  private readonly sessions = new Map<string, SessionState>();

  /** actionLatencyMs simulates asynchronous actuation time so cancellation/timeout paths are real. */
  constructor(private readonly actionLatencyMs = 0) {
    if (!Number.isFinite(actionLatencyMs) || actionLatencyMs < 0) {
      throw new Error('actionLatencyMs must be a non-negative finite number');
    }
  }

  observe(sessionId: string): MockObservation {
    const state = this.getState(sessionId);

    return {
      sessionId,
      environmentId: 'mock-room-v1',
      step: state.step,
      pose: { ...state.pose },
      gripper: state.gripper,
      objects: [
        { id: 'red-mug', label: 'red mug', position: [1, 0, 0] },
        { id: 'wooden-table', label: 'wooden table', position: [2, 0, 0] }
      ],
      timestamp: new Date().toISOString()
    };
  }

  execute(
    sessionId: string,
    actionType: EmbodiedActionType,
    parameters: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<MockActionResult> {
    if (signal?.aborted) return Promise.reject(new Error('action cancelled'));

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error('action cancelled'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        try {
          resolve(this.applyAction(sessionId, actionType, parameters));
        } catch (error) {
          reject(error);
        }
      }, this.actionLatencyMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private applyAction(
    sessionId: string,
    actionType: EmbodiedActionType,
    parameters: Record<string, unknown>
  ): MockActionResult {
    const state = this.getState(sessionId);
    if (actionType === 'move_relative') {
      state.pose.x += this.numberParameter(parameters, 'dx');
      state.pose.y += this.numberParameter(parameters, 'dy');
      state.pose.z += this.numberParameter(parameters, 'dz');
    } else if (actionType === 'goto') {
      state.pose.x = this.numberParameter(parameters, 'x');
      state.pose.y = this.numberParameter(parameters, 'y');
      state.pose.z = this.numberParameter(parameters, 'z');
    } else if (actionType === 'pick') {
      state.gripper = 'closed';
    } else if (actionType === 'place' || actionType === 'open') {
      state.gripper = 'open';
    }
    state.step += 1;

    return {
      actionType,
      step: state.step,
      pose: { ...state.pose },
      gripper: state.gripper,
      message: `${actionType} completed in mock-room-v1`
    };
  }

  queryState(sessionId: string): { readonly pose: Pose; readonly gripper: GripperState; readonly objects: readonly MockObject[] } {
    const observation = this.observe(sessionId);
    const state = this.getState(sessionId);
    return { pose: observation.pose, gripper: state.gripper, objects: observation.objects };
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  resetAll(): void {
    this.sessions.clear();
  }

  private getState(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const state: SessionState = {
      step: 0,
      pose: { x: 0, y: 0, z: 0, yaw: 0 },
      gripper: 'open'
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private numberParameter(parameters: Record<string, unknown>, name: string): number {
    const value = parameters[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`parameter ${name} must be a finite number`);
    }
    return value;
  }
}