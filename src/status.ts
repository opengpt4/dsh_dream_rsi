import { defineTool } from '@deepseek-ai/dsh-tools';

import type { DreamRsiConfig } from './config.js';

export interface DreamRsiStatus {
  readonly enabled: boolean;
  readonly evolutionEnabled: boolean;
  readonly autoDeployEnabled: boolean;
  readonly embodiedEnabled: boolean;
  readonly storage: { readonly sqlitePath: string; readonly artifactDir: string };
  readonly replay: { readonly maxNodes: number; readonly missRateMax: number };
  readonly evaluation: {
    readonly trainRatio: number;
    readonly validationRatio: number;
    readonly holdoutRatio: number;
    readonly minimumHoldoutSamples: number;
  };
}

/** Pure projection of config into the read-only status the `dream_status` tool exposes. */
export function getDreamRsiStatus(config: DreamRsiConfig): DreamRsiStatus {
  return {
    enabled: config.enabled,
    evolutionEnabled: config.evolution.enabled,
    autoDeployEnabled: config.evolution.autoDeploy,
    embodiedEnabled: config.embodied.enabled,
    storage: { sqlitePath: config.storage.sqlitePath, artifactDir: config.storage.artifactDir },
    replay: { maxNodes: config.replay.maxNodes, missRateMax: config.replay.missRateMax },
    evaluation: {
      trainRatio: config.evaluation.trainRatio,
      validationRatio: config.evaluation.validationRatio,
      holdoutRatio: config.evaluation.holdoutRatio,
      minimumHoldoutSamples: config.evaluation.minimumHoldoutSamples
    }
  };
}

/**
 * Stands in for the `dream status` command from FUNCTIONAL_SPEC.md section
 * 4.4 as a tool, because a verified Cordis/DSH command registration contract
 * does not exist in this repository's pinned dependencies (see BASELINE.md).
 */
export function createStatusTool(config: DreamRsiConfig) {
  return defineTool({
    name: 'dream_status',
    description: 'Read-only Dream-RSI status: which capabilities are enabled and safety-relevant configuration. No side effects.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          evolution_enabled: { type: 'boolean', required: true },
          auto_deploy_enabled: { type: 'boolean', required: true },
          embodied_enabled: { type: 'boolean', required: true },
          storage: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sqlite_path: { type: 'string', required: true },
              artifact_dir: { type: 'string', required: true }
            }
          },
          replay: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              max_nodes: { type: 'integer', required: true },
              miss_rate_max: { type: 'number', required: true }
            }
          },
          evaluation: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              train_ratio: { type: 'number', required: true },
              validation_ratio: { type: 'number', required: true },
              holdout_ratio: { type: 'number', required: true },
              minimum_holdout_samples: { type: 'integer', required: true }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    isConcurrencySafe: () => true,
    async execute() {
      const status = getDreamRsiStatus(config);
      return {
        enabled: status.enabled,
        evolution_enabled: status.evolutionEnabled,
        auto_deploy_enabled: status.autoDeployEnabled,
        embodied_enabled: status.embodiedEnabled,
        storage: { sqlite_path: status.storage.sqlitePath, artifact_dir: status.storage.artifactDir },
        replay: { max_nodes: status.replay.maxNodes, miss_rate_max: status.replay.missRateMax },
        evaluation: {
          train_ratio: status.evaluation.trainRatio,
          validation_ratio: status.evaluation.validationRatio,
          holdout_ratio: status.evaluation.holdoutRatio,
          minimum_holdout_samples: status.evaluation.minimumHoldoutSamples
        }
      };
    }
  });
}
