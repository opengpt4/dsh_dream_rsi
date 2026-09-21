export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Stored in every node so a reader can tell which schema wrote it. */
export const DISCOVERY_NODE_SCHEMA_VERSION = 1;

export interface DiscoveryNode {
  readonly nodeId: string;
  readonly taskId: string;
  readonly parentId: string | null;
  readonly policyVersion: string;
  readonly environmentVersion: string;
  readonly stateHash: string;
  readonly observationHash: string;
  readonly actionType: string;
  readonly actionParams: JsonValue;
  readonly result: JsonValue;
  readonly score: number;
  readonly tokenCost: number;
  readonly execTimeMs: number;
  readonly criticalPathMs?: number;
  readonly sessionId?: string;
  readonly episodeId?: string;
  readonly episodeStep?: number;
  readonly correlationId?: string;
  readonly idempotencyKey: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
}

export interface DiscoveryStore {
  append(node: DiscoveryNode): DiscoveryNode;
  get(nodeId: string): DiscoveryNode | undefined;
  listByTask(taskId: string): DiscoveryNode[];
}

export class InMemoryDiscoveryStore implements DiscoveryStore {
  private readonly nodesById = new Map<string, DiscoveryNode>();
  private readonly nodesByIdempotencyKey = new Map<string, DiscoveryNode>();

  append(node: DiscoveryNode): DiscoveryNode {
    const existing = this.nodesByIdempotencyKey.get(node.idempotencyKey);
    if (existing !== undefined) return existing;
    if (this.nodesById.has(node.nodeId)) {
      throw new Error(`node ${node.nodeId} already exists`);
    }
    this.nodesById.set(node.nodeId, node);
    this.nodesByIdempotencyKey.set(node.idempotencyKey, node);
    return node;
  }

  get(nodeId: string): DiscoveryNode | undefined {
    return this.nodesById.get(nodeId);
  }

  listByTask(taskId: string): DiscoveryNode[] {
    return [...this.nodesById.values()]
      .filter((node) => node.taskId === taskId)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }
}
