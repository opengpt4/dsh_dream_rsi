import type { DiscoveryNode, JsonValue } from '../discovery/models.js';
import { canonicalJson } from '../hash.js';
import { createReplayKey, replayKeyInputFromNode, type ReplayKeyInput } from './key.js';

export interface ReplayHit {
  readonly kind: 'hit';
  readonly replayKey: string;
  readonly node: DiscoveryNode;
}

export interface ReplayBoundaryMiss {
  readonly kind: 'boundary_miss';
  readonly replayKey: string;
  readonly availableActionTypes: readonly string[];
}

export type ReplayResult = ReplayHit | ReplayBoundaryMiss;

/** The part of a replay key that identifies a state, without an action. */
export type ReplayState = Pick<ReplayKeyInput, 'environmentVersion' | 'stateHash' | 'observationHash'>;

export interface ReplayAction {
  readonly actionType: string;
  readonly normalizedActionParams: JsonValue;
}

export interface CounterfactualBranch {
  readonly actionType: string;
  readonly result: ReplayResult;
}

export interface ReplayMetrics {
  readonly hitCount: number;
  readonly missCount: number;
  readonly visitedNodeIds: readonly string[];
}

export class ReplaySimulator {
  private readonly nodesByReplayKey = new Map<string, DiscoveryNode>();
  private readonly actionsByState = new Map<string, ReplayAction[]>();
  private readonly visitedNodeIds: string[] = [];
  private hitCount = 0;
  private missCount = 0;

  constructor(nodes: readonly DiscoveryNode[] = []) {
    for (const node of nodes) this.register(node);
  }

  register(node: DiscoveryNode): void {
    const replayKey = createReplayKey(replayKeyInputFromNode(node));
    this.nodesByReplayKey.set(replayKey, node);
    const stateKey = this.stateKey(node);
    const actions = this.actionsByState.get(stateKey) ?? [];
    const action: ReplayAction = { actionType: node.actionType, normalizedActionParams: node.actionParams };
    // The params are kept, not just the action name: two `move_relative` calls
    // with different distances are different alternatives.
    if (!actions.some((existing) => this.sameAction(existing, action))) actions.push(action);
    this.actionsByState.set(stateKey, actions);
  }

  execute(input: ReplayKeyInput): ReplayResult {
    const replayKey = createReplayKey(input);
    const node = this.nodesByReplayKey.get(replayKey);
    if (node !== undefined) {
      this.hitCount += 1;
      this.visitedNodeIds.push(node.nodeId);
      return { kind: 'hit', replayKey, node };
    }

    this.missCount += 1;
    const actionTypes = (this.actionsByState.get(this.stateKey(input)) ?? []).map((action) => action.actionType);
    return {
      kind: 'boundary_miss',
      replayKey,
      availableActionTypes: [...new Set(actionTypes)].sort()
    };
  }

  /**
   * Every action the recorded tree took from this state.
   *
   * Exposed so a caller can ask what alternatives exist before asking what each
   * would have produced; guessing the action set would make the answer depend
   * on the guess.
   */
  recordedActions(state: ReplayState): readonly ReplayAction[] {
    return (this.actionsByState.get(this.stateKey(state)) ?? []).map((action) => ({ ...action }));
  }

  /**
   * What the recorded tree knows about each alternative action from one state.
   *
   * This is the counterfactual branch: the same state compared against several
   * recorded actions, resolved from history without re-running the model or the
   * environment. An action never taken from this state resolves to a boundary
   * miss, which is itself the answer.
   */
  counterfactual(state: ReplayState, actions: readonly ReplayAction[]): readonly CounterfactualBranch[] {
    return actions.map((action) => ({
      actionType: action.actionType,
      result: this.execute({
        environmentVersion: state.environmentVersion,
        stateHash: state.stateHash,
        observationHash: state.observationHash,
        actionType: action.actionType,
        normalizedActionParams: action.normalizedActionParams
      })
    }));
  }

  private sameAction(left: ReplayAction, right: ReplayAction): boolean {
    return (
      left.actionType === right.actionType &&
      canonicalJson(left.normalizedActionParams) === canonicalJson(right.normalizedActionParams)
    );
  }

  metrics(): ReplayMetrics {
    return {
      hitCount: this.hitCount,
      missCount: this.missCount,
      visitedNodeIds: [...this.visitedNodeIds]
    };
  }

  private stateKey(input: Pick<ReplayKeyInput, 'environmentVersion' | 'stateHash' | 'observationHash'>): string {
    return `${input.environmentVersion}:${input.stateHash}:${input.observationHash}`;
  }
}
