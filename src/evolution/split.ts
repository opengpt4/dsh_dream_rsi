import { createHash } from 'node:crypto';

import type { DiscoveryNode } from '../discovery/models.js';

export type EvaluationSplitName = 'train' | 'validation' | 'holdout';

export interface EvaluationSplitConfig {
  readonly trainRatio: number;
  readonly validationRatio: number;
  readonly holdoutRatio: number;
  readonly seed: string;
}

export interface EvaluationSplit {
  readonly train: readonly DiscoveryNode[];
  readonly validation: readonly DiscoveryNode[];
  readonly holdout: readonly DiscoveryNode[];
  readonly taskAssignments: Readonly<Record<string, EvaluationSplitName>>;
}

export const DEFAULT_SPLIT_CONFIG: EvaluationSplitConfig = {
  trainRatio: 0.7,
  validationRatio: 0.15,
  holdoutRatio: 0.15,
  seed: 'dream-rsi-v1'
};

export function splitDiscoveryNodes(
  nodes: readonly DiscoveryNode[],
  config: EvaluationSplitConfig = DEFAULT_SPLIT_CONFIG
): EvaluationSplit {
  validateRatios(config);
  const taskAssignments: Record<string, EvaluationSplitName> = {};
  for (const taskId of [...new Set(nodes.map((node) => node.taskId))].sort()) {
    taskAssignments[taskId] = bucketFor(taskId, config);
  }

  const split: Record<EvaluationSplitName, DiscoveryNode[]> = {
    train: [],
    validation: [],
    holdout: []
  };
  for (const node of nodes) split[taskAssignments[node.taskId]!].push(node);

  return { ...split, taskAssignments };
}

/**
 * Deterministic partition for a key.
 *
 * Exported so every caller buckets identically: an ablation that partitioned
 * with a different hash would be comparing its own bug against the real split.
 */
export function bucketFor(key: string, config: EvaluationSplitConfig): EvaluationSplitName {
  const digest = createHash('sha256').update(`${config.seed}:${key}`).digest();
  const bucket = digest.readUInt32BE(0) / 0x1_0000_0000;
  if (bucket < config.trainRatio) return 'train';
  if (bucket < config.trainRatio + config.validationRatio) return 'validation';
  return 'holdout';
}

function validateRatios(config: EvaluationSplitConfig): void {
  const ratios = [config.trainRatio, config.validationRatio, config.holdoutRatio];
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio < 0)) {
    throw new Error('evaluation split ratios must be finite non-negative numbers');
  }
  if (Math.abs(ratios.reduce((sum, ratio) => sum + ratio, 0) - 1) > 1e-9) {
    throw new Error('evaluation split ratios must sum to 1');
  }
}