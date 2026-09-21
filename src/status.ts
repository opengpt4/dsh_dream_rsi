import { defineTool } from '@deepseek-ai/dsh-tools';

import type { DreamRsiConfig } from './config.js';
import { DEFAULT_MAX_OLD_SPACE_SIZE_MB, DEFAULT_MAX_OUTPUT_BYTES } from './operations/isolated-child.js';
import { verifyReadiness, type ReadinessReport } from './readiness.js';
import type { PolicyRegistry } from './registry/policy-registry.js';
import type { EvaluationReport } from './registry/models.js';
import type { DreamRsiRuntime } from './runtime.js';

/** The most recent evaluation report a registry holds. */
export interface LatestEvaluation {
  readonly evaluationId: string;
  readonly passed: boolean;
  readonly sampleCount: number;
  readonly createdAt: string;
  readonly signed: boolean;
}

/** What the persisted policy registry held when the status was taken. */
export type RegistryProbe =
  | {
      readonly state: 'read';
      readonly policyCount: number;
      readonly evaluationCount: number;
      readonly deploymentCount: number;
      readonly currentPolicy: {
        readonly artifactId: string;
        readonly version: string;
        /** Whether the artifact carries a signature, not whether one verifies. */
        readonly signed: boolean;
      } | null;
      readonly latestEvaluation: LatestEvaluation | null;
    }
  | { readonly state: 'unreadable'; readonly detail: string };

/**
 * What bounds a candidate's execution.
 *
 * The limits the isolated evaluator actually applies, read from the constants
 * and configuration it applies them from, so the report cannot drift from the
 * enforcement. Resource *consumption* is not reported: nothing accounts for it
 * per child, and a process-wide number would read as if something did.
 */
export interface ResourceLimits {
  readonly heapCapMb: number;
  readonly wallClockMs: number;
  readonly maxOutputBytes: number;
  /**
   * The confinement the host named, or `null` when the child runs directly.
   *
   * Reported because CPU-time and network limits are the runtime's flags, not
   * the plugin's: an operator asking what bounds a candidate has to see this.
   */
  readonly sandbox: { readonly command: string; readonly args: readonly string[] } | null;
}

export interface DreamRsiStatus {
  readonly enabled: boolean;
  readonly evolutionEnabled: boolean;
  readonly autoDeployEnabled: boolean;
  readonly embodiedEnabled: boolean;
  readonly storage: { readonly sqlitePath: string; readonly artifactDir: string; readonly registryDir: string };
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
  /** The limits a candidate's evaluation runs under. */
  readonly resources: ResourceLimits;
  /** Present when the status tool was given a runtime to inspect. */
  readonly readiness?: ReadinessReport;
  /** Present when the status tool was given a runtime whose registry could be read. */
  readonly registry?: RegistryProbe;
}

/** Pure projection of config into the read-only status the `dream_status` tool exposes. */
export function getDreamRsiStatus(config: DreamRsiConfig, runtime?: DreamRsiRuntime): DreamRsiStatus {
  const probe: { status?: RegistryProbe; registry?: PolicyRegistry } =
    runtime === undefined ? {} : probeRegistry(runtime);
  return {
    enabled: config.enabled,
    evolutionEnabled: config.evolution.enabled,
    autoDeployEnabled: config.evolution.autoDeploy,
    embodiedEnabled: config.embodied.enabled,
    storage: {
      sqlitePath: config.storage.sqlitePath,
      artifactDir: config.storage.artifactDir,
      registryDir: config.storage.registryDir
    },
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
    resources: {
      heapCapMb: DEFAULT_MAX_OLD_SPACE_SIZE_MB,
      wallClockMs: config.evaluation.timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      sandbox:
        config.evaluation.sandboxCommand.trim().length === 0
          ? null
          : { command: config.evaluation.sandboxCommand, args: [...config.evaluation.sandboxArgs] }
    },
    // Storage is never probed here: opening it would create a database file,
    // and this tool is documented as side-effect free. The registry is read
    // through a view that creates nothing, so a missing directory stays absent.
    ...(runtime !== undefined
      ? { readiness: verifyReadiness({ runtime, ...(probe.registry !== undefined ? { registry: probe.registry } : {}) }) }
      : {}),
    ...(probe.status !== undefined ? { registry: probe.status } : {})
  };
}

/**
 * Read the registry, and keep the registry when it was read.
 *
 * A corrupt registry is reported rather than thrown: the status call is how an
 * operator finds out, and a tool error reads as a broken tool. The failure is
 * named in `detail` so it is not mistaken for an empty registry.
 */
function probeRegistry(runtime: DreamRsiRuntime): { status: RegistryProbe; registry?: PolicyRegistry } {
  try {
    const registry = runtime.readPolicyRegistry();
    const current = registry.currentPolicyArtifactId();
    const currentArtifact = current === null ? undefined : registry.policy(current);
    if (current !== null && currentArtifact === undefined) {
      // The loader refuses this state, so reaching it means the view and the
      // pointer disagree; reporting it beats inventing a version.
      throw new Error(`the current policy pointer names unregistered artifact ${current}`);
    }
    return {
      status: {
        state: 'read',
        policyCount: registry.policyCount(),
        evaluationCount: registry.evaluationCount(),
        deploymentCount: registry.listDeployments().length,
        currentPolicy:
          current === null || currentArtifact === undefined
            ? null
            : {
                artifactId: current,
                version: currentArtifact.version,
                signed: currentArtifact.signature !== undefined
              },
        latestEvaluation: latestEvaluation(registry.listEvaluations())
      },
      registry
    };
  } catch (error) {
    return { status: { state: 'unreadable', detail: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * The most recent evaluation report.
 *
 * Most recent by `createdAt`, and on a tie by id descending: ids are content
 * hashes, so the tie-break is arbitrary but stable, and a reader comparing two
 * status calls sees the same report for the same registry.
 */
function latestEvaluation(reports: readonly EvaluationReport[]): LatestEvaluation | null {
  let latest: EvaluationReport | undefined;
  for (const report of reports) {
    if (latest === undefined) { latest = report; continue; }
    if (report.createdAt !== latest.createdAt) {
      if (report.createdAt > latest.createdAt) latest = report;
      continue;
    }
    if (report.evaluationId > latest.evaluationId) latest = report;
  }
  return latest === undefined
    ? null
    : {
        evaluationId: latest.evaluationId,
        passed: latest.passed,
        sampleCount: latest.sampleCount,
        createdAt: latest.createdAt,
        signed: latest.signature !== undefined
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
              artifact_dir: { type: 'string', required: true },
              registry_dir: { type: 'string', required: true }
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
          resources: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              heap_cap_mb: { type: 'integer', required: true },
              wall_clock_ms: { type: 'integer', required: true },
              max_output_bytes: { type: 'integer', required: true },
              sandbox_command: { type: 'json', required: true },
              sandbox_args: { type: 'array', items: { type: 'string' }, required: true }
            }
          },
          // Present only when the tool was given a runtime to inspect. Flat, with
          // nulls for what an unreadable registry could not say, so one schema
          // covers both states.
          registry: {
            type: 'object',
            additionalProperties: false,
            properties: {
              state: { type: 'string', required: true },
              detail: { type: 'json', required: true },
              policy_count: { type: 'json', required: true },
              evaluation_count: { type: 'json', required: true },
              deployment_count: { type: 'json', required: true },
              current_policy_artifact_id: { type: 'json', required: true },
              current_policy_version: { type: 'json', required: true },
              current_policy_signed: { type: 'json', required: true },
              latest_evaluation_id: { type: 'json', required: true },
              latest_evaluation_passed: { type: 'json', required: true },
              latest_evaluation_sample_count: { type: 'json', required: true },
              latest_evaluation_created_at: { type: 'json', required: true },
              latest_evaluation_signed: { type: 'json', required: true }
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
        storage: {
          sqlite_path: status.storage.sqlitePath,
          artifact_dir: status.storage.artifactDir,
          registry_dir: status.storage.registryDir
        },
        resources: {
          heap_cap_mb: status.resources.heapCapMb,
          wall_clock_ms: status.resources.wallClockMs,
          max_output_bytes: status.resources.maxOutputBytes,
          sandbox_command: status.resources.sandbox?.command ?? null,
          sandbox_args: status.resources.sandbox === null ? [] : [...status.resources.sandbox.args]
        },
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
        ...(status.registry !== undefined ? { registry: flattenRegistry(status.registry) } : {}),
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

/**
 * One shape for both registry states, with nulls for what was not read.
 *
 * A single schema covers a read registry and an unreadable one this way; a
 * union in the tool schema would have to be expressed twice.
 */
function flattenRegistry(probe: RegistryProbe) {
  if (probe.state === 'unreadable') {
    return {
      state: probe.state,
      detail: probe.detail,
      policy_count: null,
      evaluation_count: null,
      deployment_count: null,
      current_policy_artifact_id: null,
      current_policy_version: null,
      current_policy_signed: null,
      latest_evaluation_id: null,
      latest_evaluation_passed: null,
      latest_evaluation_sample_count: null,
      latest_evaluation_created_at: null,
      latest_evaluation_signed: null
    };
  }
  return {
    state: probe.state,
    detail: null,
    policy_count: probe.policyCount,
    evaluation_count: probe.evaluationCount,
    deployment_count: probe.deploymentCount,
    current_policy_artifact_id: probe.currentPolicy?.artifactId ?? null,
    current_policy_version: probe.currentPolicy?.version ?? null,
    current_policy_signed: probe.currentPolicy?.signed ?? null,
    latest_evaluation_id: probe.latestEvaluation?.evaluationId ?? null,
    latest_evaluation_passed: probe.latestEvaluation?.passed ?? null,
    latest_evaluation_sample_count: probe.latestEvaluation?.sampleCount ?? null,
    latest_evaluation_created_at: probe.latestEvaluation?.createdAt ?? null,
    latest_evaluation_signed: probe.latestEvaluation?.signed ?? null
  };
}
