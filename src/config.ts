import Schema from '@deepseek-ai/schemastery';

import { EMBODIED_ACTION_TYPES } from './embodied/protocol.js';

import { hashJson } from './hash.js';

export interface DreamRsiConfig {
  readonly enabled: boolean;
  readonly storage: {
    readonly sqlitePath: string;
    readonly artifactDir: string;
    /** Registry records. Read-only consumers must not create this directory. */
    readonly registryDir: string;
  };
  readonly runtime: {
    readonly maxWorkers: number;
    readonly taskTimeoutMs: number;
  };
  readonly replay: {
    readonly maxNodes: number;
    readonly missRateMax: number;
    readonly keySchemaVersion: number;
  };
  readonly evaluation: {
    readonly trainRatio: number;
    readonly validationRatio: number;
    readonly holdoutRatio: number;
    readonly minimumHoldoutSamples: number;
    readonly timeoutMs: number;
  };
  readonly operations: {
    readonly evolutionLock: string;
    readonly deploymentLock: string;
    readonly jobLeaseMs: number;
  };
  readonly evolution: {
    readonly enabled: boolean;
    readonly maxCandidates: number;
    readonly autoDeploy: boolean;
    readonly minimumImprovement: number;
    /** Fraction of holdout cases whose quality must not regress. */
    readonly minimumPassRatio: number;
  };
  readonly embodied: {
    readonly enabled: boolean;
    readonly requireConfirmation: boolean;
    readonly actionLeaseMs: number;
    readonly maxActionsPerMinute: number;
    /** Subset of the declared actions this deployment may use. `string[]` matches the schema's array shape. */
    readonly allowActions: string[];
  };
}

export type DreamRsiConfigInput = Partial<{
  [Key in keyof DreamRsiConfig]: Partial<DreamRsiConfig[Key]>;
}>;

/**
 * Host-facing configuration schema. Cordis validates each fiber's `config`
 * against the schema a plugin exports as `Config`, so this is the contract a
 * `cordis.patch.yml` entry under `- insert:` is checked against.
 *
 * Shape and defaults only. Cross-field invariants are not expressible as
 * per-field constraints and live in `validateDreamRsiConfig`, which
 * `resolveDreamRsiConfig` always runs afterwards.
 */
export const DreamRsiConfigSchema = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Master switch. When false the plugin registers nothing and runs no enabled-only validation.'),
  storage: Schema.object({
    sqlitePath: Schema.string().default('data/discovery.db')
      .description('SQLite database holding Discovery nodes. ":memory:" keeps storage in-process.'),
    artifactDir: Schema.string().default('data/artifacts')
      .description('Root directory for content-addressed artifacts.'),
    registryDir: Schema.string().default('data/registry')
      .description('Root directory for policy, evaluation, and deployment records, read without being created.')
  }),
  runtime: Schema.object({
    maxWorkers: Schema.number().default(4),
    taskTimeoutMs: Schema.number().default(300_000)
  }),
  replay: Schema.object({
    maxNodes: Schema.number().default(10_000),
    missRateMax: Schema.number().default(0.05),
    keySchemaVersion: Schema.number().default(1)
  }),
  evaluation: Schema.object({
    trainRatio: Schema.number().default(0.7),
    validationRatio: Schema.number().default(0.15),
    holdoutRatio: Schema.number().default(0.15),
    minimumHoldoutSamples: Schema.number().default(20),
    timeoutMs: Schema.number().default(5_000)
  }),
  operations: Schema.object({
    evolutionLock: Schema.string().default('data/locks/evolution.lock'),
    deploymentLock: Schema.string().default('data/locks/deployment.lock'),
    jobLeaseMs: Schema.number().default(300_000)
  }),
  evolution: Schema.object({
    enabled: Schema.boolean().default(false),
    maxCandidates: Schema.number().default(8),
    autoDeploy: Schema.boolean().default(false)
      .description('Requires evolution.enabled; enforced after the schema runs.'),
    minimumImprovement: Schema.number().default(0.01),
    minimumPassRatio: Schema.number().default(0.95)
      .description('Fraction of holdout cases whose candidate quality must not fall below the incumbent.')
  }),
  embodied: Schema.object({
    enabled: Schema.boolean().default(false),
    requireConfirmation: Schema.boolean().default(true),
    actionLeaseMs: Schema.number().default(30_000),
    maxActionsPerMinute: Schema.number().default(30),
    allowActions: Schema.array(Schema.string()).default([...EMBODIED_ACTION_TYPES])
      .description('Narrows the declared action set. It can never add an action the backend does not declare.')
  })
});

/** Normalized defaults, derived from the schema so defaults have one definition. */
export const DEFAULT_DREAM_RSI_CONFIG: DreamRsiConfig = DreamRsiConfigSchema({}) as DreamRsiConfig;

export function resolveDreamRsiConfig(input: DreamRsiConfigInput = {}): DreamRsiConfig {
  const config = DreamRsiConfigSchema(input) as DreamRsiConfig;
  validateDreamRsiConfig(config);
  return config;
}

/**
 * Identity of a resolved configuration.
 *
 * Recorded on every evaluation report: a score is only comparable with another
 * score taken under the same configuration.
 */
export function hashDreamRsiConfig(config: DreamRsiConfig): string {
  return hashJson(JSON.parse(JSON.stringify(config)) as Parameters<typeof hashJson>[0]);
}

/**
 * Validate a resolved configuration.
 *
 * A disabled config is not checked: nothing will use it, and a host that turns
 * the plugin off should not have to supply settings it never reads. The values
 * are therefore only refused where they are used, and each consumer does its
 * own check rather than trusting the resolver.
 */
export function validateDreamRsiConfig(config: DreamRsiConfig): void {
  if (!config.enabled) return;
  assertPositiveInteger(config.runtime.maxWorkers, 'runtime.maxWorkers');
  assertPositiveInteger(config.replay.maxNodes, 'replay.maxNodes');
  assertPositiveInteger(config.replay.keySchemaVersion, 'replay.keySchemaVersion');
  assertPositiveInteger(config.evaluation.minimumHoldoutSamples, 'evaluation.minimumHoldoutSamples');
  assertPositiveInteger(config.evolution.maxCandidates, 'evolution.maxCandidates');
  assertPositive(config.runtime.taskTimeoutMs, 'runtime.taskTimeoutMs');
  assertPositive(config.evaluation.timeoutMs, 'evaluation.timeoutMs');
  assertPositive(config.operations.jobLeaseMs, 'operations.jobLeaseMs');
  assertPositive(config.embodied.actionLeaseMs, 'embodied.actionLeaseMs');
  assertPositiveInteger(config.embodied.maxActionsPerMinute, 'embodied.maxActionsPerMinute');
  if (config.embodied.allowActions.length === 0) {
    throw new Error('embodied.allowActions must not be empty; disable embodied instead');
  }
  for (const action of config.embodied.allowActions) {
    if (!(EMBODIED_ACTION_TYPES as readonly string[]).includes(action)) {
      throw new Error(
        `embodied.allowActions names ${action}, which is not part of the MVP action vocabulary (${EMBODIED_ACTION_TYPES.join(', ')})`
      );
    }
  }
  assertRatio(config.replay.missRateMax, 'replay.missRateMax');
  assertRatio(config.evaluation.trainRatio, 'evaluation.trainRatio');
  assertRatio(config.evaluation.validationRatio, 'evaluation.validationRatio');
  assertRatio(config.evaluation.holdoutRatio, 'evaluation.holdoutRatio');
  const ratioTotal = config.evaluation.trainRatio + config.evaluation.validationRatio + config.evaluation.holdoutRatio;
  if (Math.abs(ratioTotal - 1) > 1e-9) throw new Error('evaluation split ratios must sum to 1');
  if (config.evolution.minimumImprovement < 0 || !Number.isFinite(config.evolution.minimumImprovement)) {
    throw new Error('evolution.minimumImprovement must be non-negative and finite');
  }
  assertRatio(config.evolution.minimumPassRatio, 'evolution.minimumPassRatio');
  for (const [value, name] of [
    [config.storage.sqlitePath, 'storage.sqlitePath'],
    [config.storage.artifactDir, 'storage.artifactDir'],
    [config.storage.registryDir, 'storage.registryDir'],
    [config.operations.evolutionLock, 'operations.evolutionLock'],
    [config.operations.deploymentLock, 'operations.deploymentLock']
  ] as const) {
    if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  }
  if (config.evolution.autoDeploy && !config.evolution.enabled) {
    throw new Error('evolution.autoDeploy requires evolution.enabled');
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}
