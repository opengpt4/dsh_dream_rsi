export interface MockObject {
  readonly id: string;
  readonly label: string;
  readonly position: readonly [number, number, number];
}

export interface MockObservation {
  readonly sessionId: string;
  readonly environmentId: 'mock-room-v1';
  readonly step: number;
  readonly pose: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
  };
  readonly objects: readonly MockObject[];
  readonly timestamp: string;
}

interface SessionState {
  step: number;
  pose: {
    x: number;
    y: number;
    z: number;
    yaw: number;
  };
  gripper: 'open' | 'closed';
}

export type EmbodiedActionType = 'move_relative' | 'goto' | 'pick' | 'place' | 'open';

export interface ActionResult {
  readonly actionType: EmbodiedActionType;
  readonly step: number;
  readonly pose: MockObservation['pose'];
  readonly gripper: 'open' | 'closed';
  readonly message: string;
}

export class MockEmbodiedBackend {
  private readonly sessions = new Map<string, SessionState>();

  observe(sessionId: string): MockObservation {
    const state = this.getState(sessionId);
    this.sessions.set(sessionId, state);

    return {
      sessionId,
      environmentId: 'mock-room-v1',
      step: state.step,
      pose: state.pose,
      objects: [
        { id: 'red-mug', label: 'red mug', position: [1, 0, 0] },
        { id: 'wooden-table', label: 'wooden table', position: [2, 0, 0] }
      ],
      timestamp: new Date().toISOString()
    };
  }

  execute(sessionId: string, actionType: EmbodiedActionType, parameters: Record<string, unknown>): ActionResult {
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
      pose: state.pose,
      gripper: state.gripper,
      message: `${actionType} completed in mock-room-v1`
    };
  }

  queryState(sessionId: string): { readonly pose: MockObservation['pose']; readonly gripper: 'open' | 'closed'; readonly objects: readonly MockObject[] } {
    const observation = this.observe(sessionId);
    const state = this.getState(sessionId);
    return { pose: observation.pose, gripper: state.gripper, objects: observation.objects };
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
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