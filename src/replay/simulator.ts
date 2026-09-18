import type { DiscoveryNode } from '../discovery/models.js';
import { createReplayKey, type ReplayKeyInput } from './key.js';

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

export interface ReplayMetrics {
  readonly hitCount: number;
  readonly missCount: number;
  readonly visitedNodeIds: readonly string[];
}

export class ReplaySimulator {
  private readonly nodesByReplayKey = new Map<string, DiscoveryNode>();
  private readonly actionTypesByState = new Map<string, Set<string>>();
  private readonly visitedNodeIds: string[] = [];
  private hitCount = 0;
  private missCount = 0;

  constructor(nodes: readonly DiscoveryNode[] = []) {
    for (const node of nodes) this.register(node);
  }

  register(node: DiscoveryNode): void {
    const replayKey = createReplayKey(this.keyInput(node));
    this.nodesByReplayKey.set(replayKey, node);
    const stateKey = this.stateKey(node);
    const actionTypes = this.actionTypesByState.get(stateKey) ?? new Set<string>();
    actionTypes.add(node.actionType);
    this.actionTypesByState.set(stateKey, actionTypes);
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
    const actionTypes = this.actionTypesByState.get(this.stateKey(input));
    return {
      kind: 'boundary_miss',
      replayKey,
      availableActionTypes: [...(actionTypes ?? [])].sort()
    };
  }

  metrics(): ReplayMetrics {
    return {
      hitCount: this.hitCount,
      missCount: this.missCount,
      visitedNodeIds: [...this.visitedNodeIds]
    };
  }

  private keyInput(node: DiscoveryNode): ReplayKeyInput {
    return {
      environmentVersion: node.environmentVersion,
      stateHash: node.stateHash,
      actionType: node.actionType,
      normalizedActionParams: node.actionParams,
      observationHash: node.observationHash
    };
  }

  private stateKey(input: Pick<ReplayKeyInput, 'environmentVersion' | 'stateHash' | 'observationHash'>): string {
    return `${input.environmentVersion}:${input.stateHash}:${input.observationHash}`;
  }
}
