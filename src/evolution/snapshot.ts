import { createHash } from 'node:crypto';

import type { DiscoveryNode, JsonValue } from '../discovery/models.js';
import { splitDiscoveryNodes, type EvaluationSplit, type EvaluationSplitConfig } from './split.js';

export interface EvaluationSnapshot {
  readonly snapshotId: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly splits: EvaluationSplit;
}

export function createEvaluationSnapshot(
  nodes: readonly DiscoveryNode[],
  config?: EvaluationSplitConfig,
  createdAt = new Date().toISOString()
): EvaluationSnapshot {
  const clonedNodes = nodes.map((node) => cloneAndFreeze(node));
  const splits = splitDiscoveryNodes(clonedNodes, config);
  const snapshotId = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, createdAt, splits }))
    .digest('hex');
  return deepFreeze({ snapshotId, schemaVersion: 1, createdAt, splits });
}

function cloneAndFreeze<T extends object>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function snapshotJsonValue(snapshot: EvaluationSnapshot): JsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as JsonValue;
}