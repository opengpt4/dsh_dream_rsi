export interface DreamRsiConfig {
  readonly enabled: boolean;
  readonly storage: {
    readonly sqlitePath: string;
    readonly artifactDir: string;
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
  };
  readonly embodied: {
    readonly enabled: boolean;
    readonly requireConfirmation: boolean;
    readonly actionLeaseMs: number;
    readonly maxActionsPerMinute: number;
  };
}

export type DreamRsiConfigInput = Partial<{
  [Key in keyof DreamRsiConfig]: Partial<DreamRsiConfig[Key]>;
}>;

export const DEFAULT_DREAM_RSI_CONFIG: DreamRsiConfig = {
  enabled: true,
  storage: { sqlitePath: 'data/discovery.db', artifactDir: 'data/artifacts' },
  runtime: { maxWorkers: 4, taskTimeoutMs: 300_000 },
  replay: { maxNodes: 10_000, missRateMax: 0.05, keySchemaVersion: 1 },
  evaluation: {
    trainRatio: 0.7,
    validationRatio: 0.15,
    holdoutRatio: 0.15,
    minimumHoldoutSamples: 20,
    timeoutMs: 5_000
  },
  operations: {
    evolutionLock: 'data/locks/evolution.lock',
    deploymentLock: 'data/locks/deployment.lock',
    jobLeaseMs: 300_000
  },
  evolution: { enabled: false, maxCandidates: 8, autoDeploy: false, minimumImprovement: 0.01 },
  embodied: { enabled: false, requireConfirmation: true, actionLeaseMs: 30_000, maxActionsPerMinute: 30 }
};

export function resolveDreamRsiConfig(input: DreamRsiConfigInput = {}): DreamRsiConfig {
  const config: DreamRsiConfig = {
    ...DEFAULT_DREAM_RSI_CONFIG,
    ...input,
    storage: { ...DEFAULT_DREAM_RSI_CONFIG.storage, ...input.storage },
    runtime: { ...DEFAULT_DREAM_RSI_CONFIG.runtime, ...input.runtime },
    replay: { ...DEFAULT_DREAM_RSI_CONFIG.replay, ...input.replay },
    evaluation: { ...DEFAULT_DREAM_RSI_CONFIG.evaluation, ...input.evaluation },
    operations: { ...DEFAULT_DREAM_RSI_CONFIG.operations, ...input.operations },
    evolution: { ...DEFAULT_DREAM_RSI_CONFIG.evolution, ...input.evolution },
    embodied: { ...DEFAULT_DREAM_RSI_CONFIG.embodied, ...input.embodied }
  };

  validateDreamRsiConfig(config);
  return config;
}

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
  assertRatio(config.replay.missRateMax, 'replay.missRateMax');
  assertRatio(config.evaluation.trainRatio, 'evaluation.trainRatio');
  assertRatio(config.evaluation.validationRatio, 'evaluation.validationRatio');
  assertRatio(config.evaluation.holdoutRatio, 'evaluation.holdoutRatio');
  const ratioTotal = config.evaluation.trainRatio + config.evaluation.validationRatio + config.evaluation.holdoutRatio;
  if (Math.abs(ratioTotal - 1) > 1e-9) throw new Error('evaluation split ratios must sum to 1');
  if (config.evolution.minimumImprovement < 0 || !Number.isFinite(config.evolution.minimumImprovement)) {
    throw new Error('evolution.minimumImprovement must be non-negative and finite');
  }
  for (const [value, name] of [
    [config.storage.sqlitePath, 'storage.sqlitePath'],
    [config.storage.artifactDir, 'storage.artifactDir'],
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