import { createHash } from 'node:crypto';

import type { DiscoveryNode, JsonValue } from '../discovery/models.js';
import { splitDiscoveryNodes, type EvaluationSplit, type EvaluationSplitConfig } from './split.js';

export interface EvaluationSnapshot {
  readonly snapshotId: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly splits: EvaluationSplit;
}

/**
 * Freeze a node set into an evaluation snapshot.
 *
 * `snapshotId` covers the content and nothing else. `createdAt` is recorded on
 * the snapshot but excluded from the id: including it would mean two snapshots
 * of the identical tree never shared an id, so nothing could tell "the same
 * tree" from "a different tree at a different time", and the id would not be a
 * content address. Node-level `createdAt` values are already part of the
 * content, so the identity still covers when the work happened.
 */
export function createEvaluationSnapshot(
  nodes: readonly DiscoveryNode[],
  config?: EvaluationSplitConfig,
  createdAt = new Date().toISOString()
): EvaluationSnapshot {
  const clonedNodes = nodes.map((node) => cloneAndFreeze(node));
  const splits = splitDiscoveryNodes(clonedNodes, config);
  const snapshotId = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, splits }))
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