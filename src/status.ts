import { defineTool } from '@deepseek-ai/dsh-tools';

import type { DreamRsiConfig } from './config.js';
import { verifyReadiness, type ReadinessReport } from './readiness.js';
import type { DreamRsiRuntime } from './runtime.js';

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
  /**
   * What an action may do, and how good a candidate must be to replace the live
   * policy.
   *
   * These are the settings a reader needs to answer "will this action be
   * admitted" and "could this candidate be promoted" — the enabled booleans
   * above say whether a capability is on, not what it permits.
   */
  readonly safetyControls: {
    readonly requireConfirmation: boolean;
    readonly allowedActions: readonly string[];
    readonly actionLeaseMs: number;
    readonly maxActionsPerMinute: number;
    readonly minimumPassRatio: number;
    readonly minimumImprovement: number;
  };
  /** Present when the status tool was given a runtime to inspect. */
  readonly readiness?: ReadinessReport;
}

/** Pure projection of config into the read-only status the `dream_status` tool exposes. */
export function getDreamRsiStatus(config: DreamRsiConfig, runtime?: DreamRsiRuntime): DreamRsiStatus {
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
    },
    safetyControls: {
      requireConfirmation: config.embodied.requireConfirmation,
      allowedActions: [...config.embodied.allowActions],
      actionLeaseMs: config.embodied.actionLeaseMs,
      maxActionsPerMinute: config.embodied.maxActionsPerMinute,
      minimumPassRatio: config.evolution.minimumPassRatio,
      minimumImprovement: config.evolution.minimumImprovement
    },
    // Storage is never probed here: opening it would create a database file,
    // and this tool is documented as side-effect free.
    ...(runtime !== undefined ? { readiness: verifyReadiness({ runtime }) } : {})
  };
}

/**
 * Stands in for the `dream status` command from FUNCTIONAL_SPEC.md section
 * 4.4 as a tool, because a verified Cordis/DSH command registration contract
 * does not exist in this repository's pinned dependencies (see BASELINE.md).
 */
export function createStatusTool(config: DreamRsiConfig, runtime?: DreamRsiRuntime) {
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
          },
          safety_controls: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              require_confirmation: { type: 'boolean', required: true },
              allowed_actions: { type: 'array', items: { type: 'string' }, required: true },
              action_lease_ms: { type: 'integer', required: true },
              max_actions_per_minute: { type: 'integer', required: true },
              minimum_pass_ratio: { type: 'number', required: true },
              minimum_improvement: { type: 'number', required: true }
            }
          },
          // Present only when the tool was given a runtime to inspect.
          readiness: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ready: { type: 'boolean', required: true },
              checked_at: { type: 'string', required: true },
              checks: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    state: { type: 'string', required: true },
                    detail: { type: 'string', required: true }
                  }
                }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    isConcurrencySafe: () => true,
    async execute() {
      // Passing the runtime through is what makes readiness part of the tool
      // rather than only of the function behind it.
      const status = getDreamRsiStatus(config, runtime);
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
        },
        safety_controls: {
          require_confirmation: status.safetyControls.requireConfirmation,
          allowed_actions: [...status.safetyControls.allowedActions],
          action_lease_ms: status.safetyControls.actionLeaseMs,
          max_actions_per_minute: status.safetyControls.maxActionsPerMinute,
          minimum_pass_ratio: status.safetyControls.minimumPassRatio,
          minimum_improvement: status.safetyControls.minimumImprovement
        },
        ...(status.readiness !== undefined
          ? {
              readiness: {
                ready: status.readiness.ready,
                checked_at: status.readiness.checkedAt,
                checks: status.readiness.checks.map((check) => ({
                  name: check.name,
                  state: check.state,
                  detail: check.detail
                }))
              }
            }
          : {})
      };
    }
  });
}
