import { validateDreamRsiConfig, type DreamRsiConfig } from './config.js';
import type { CapabilityProfile } from './embodied/capability.js';
import { InMemoryDiscoveryStore, type DiscoveryStore } from './discovery/models.js';
import { SQLiteDiscoveryStore } from './discovery/sqlite-store.js';
import { MockEmbodiedBackend } from './embodied/backend.js';
import { MockEnvironmentAdapter } from './embodied/mock-adapter.js';
import { DEFAULT_HOLDOUT_GATE_CONFIG, type HoldoutGateConfig } from './evolution/holdout-gate.js';
import { DEFAULT_SPLIT_CONFIG, type EvaluationSplitConfig } from './evolution/split.js';
import { SingleWriterLock } from './operations/single-writer-lock.js';
import { InMemoryAuditLog, type AuditSink } from './registry/audit.js';
import { ActionGuard, type ConfirmationRequest } from './safety/action-guard.js';
import { narrowCapabilityProfile } from './embodied/capability.js';
import { MOCK_CAPABILITY_PROFILE } from './safety/capability.js';

/** Replay ceilings derived from config, consumed by the episode pipeline. */
export interface ReplaySettings {
  readonly maxNodes: number;
  readonly missRateMax: number;
  readonly keySchemaVersion: number;
}

/** Evaluation ceilings derived from config, consumed by the episode pipeline. */
export interface EvaluationSettings {
  readonly timeoutMs: number;
  readonly minimumHoldoutSamples: number;
  readonly splitConfig: EvaluationSplitConfig;
  /**
   * Thresholds the holdout gate runs with, derived from config.
   *
   * Without this the gate's defaults were the only values it ever used, so
   * `evolution.minimumImprovement` was configurable in name only.
   */
  readonly holdoutGate: HoldoutGateConfig;
}

/**
 * Resources constructed from a validated config, so every consumer reads the
 * same store, backend, and locks for the life of one plugin fiber.
 */
export interface DreamRsiRuntime {
  readonly config: DreamRsiConfig;
  /** Materialized on first access; see {@link createDreamRsiRuntime}. */
  readonly store: DiscoveryStore;
  readonly backend: MockEmbodiedBackend;
  /** Same backend as {@link backend}, so tools and episodes share session state. */
  readonly adapter: MockEnvironmentAdapter;
  readonly splitConfig: EvaluationSplitConfig;
  readonly replaySettings: ReplaySettings;
  readonly evaluationSettings: EvaluationSettings;
  /**
   * The capability profile actually in force, after `embodied.allowActions`.
   *
   * Exposed because the declared profile and the effective one differ once
   * configuration narrows it, and a reader needs the effective one.
   */
  readonly capabilityProfile: CapabilityProfile;
  /** Enforces the action safety contract for every action this runtime dispatches. */
  readonly guard: ActionGuard;
  readonly audit: AuditSink;
  readonly evolutionLock: SingleWriterLock;
  readonly deploymentLock: SingleWriterLock;
  /** Releases every resource this runtime owns. Safe to call more than once. */
  dispose(): void;
}

/**
 * Host-provided approvals.
 *
 * `confirm` is absent by default, which denies every action whose capability
 * requires confirmation. Approval is opt-in, never implied.
 */
export interface DreamRsiHooks {
  readonly confirm?: (request: ConfirmationRequest) => boolean;
  /** Audit sink for operator stops. Defaults to an in-process log. */
  readonly audit?: AuditSink;
}

/**
 * Build the runtime for one config.
 *
 * Validates before constructing anything: an invalid config must throw rather
 * than create the SQLite file or hand back a partially-built runtime. A
 * disabled config is the exception — `validateDreamRsiConfig` returns early for
 * one, so its values are not checked here. That is safe because each consumer
 * validates what it is handed, which is what `test/config.test.mjs` pins.
 *
 * The store is built on first access. Opening it is what creates the database
 * file and its parent directory, and mounting the plugin must not write to the
 * host filesystem before anything reads a Discovery node.
 */
export function createDreamRsiRuntime(config: DreamRsiConfig, hooks: DreamRsiHooks = {}): DreamRsiRuntime {
  validateDreamRsiConfig(config);

  let disposed = false;
  let sqlite: SQLiteDiscoveryStore | undefined;
  let store: DiscoveryStore | undefined;
  const backend = new MockEmbodiedBackend();
  const adapter = new MockEnvironmentAdapter(backend);
  const audit = hooks.audit ?? new InMemoryAuditLog();
  // Config tightens the declared profile and can never widen it.
  const capabilityProfile = narrowCapabilityProfile(MOCK_CAPABILITY_PROFILE, config.embodied.allowActions);
  const guard = new ActionGuard({
    profile: capabilityProfile,
    actionLeaseMs: config.embodied.actionLeaseMs,
    maxActionsPerMinute: config.embodied.maxActionsPerMinute,
    requireConfirmation: config.embodied.requireConfirmation,
    audit,
    ...(hooks.confirm !== undefined ? { confirm: hooks.confirm } : {})
  });
  const splitConfig: EvaluationSplitConfig = {
    trainRatio: config.evaluation.trainRatio,
    validationRatio: config.evaluation.validationRatio,
    holdoutRatio: config.evaluation.holdoutRatio,
    // Stable seed: one task must land in the same partition on every run, or
    // replay scores are not comparable between evaluations.
    seed: DEFAULT_SPLIT_CONFIG.seed
  };

  return {
    config,
    get store(): DiscoveryStore {
      if (store === undefined) {
        sqlite = config.storage.sqlitePath === ':memory:'
          ? undefined
          : new SQLiteDiscoveryStore(config.storage.sqlitePath);
        store = sqlite ?? new InMemoryDiscoveryStore();
      }
      return store;
    },
    backend,
    // One backend instance behind both surfaces, so an action taken through a
    // tool and an action taken by an episode observe the same environment.
    adapter,
    splitConfig,
    replaySettings: {
      maxNodes: config.replay.maxNodes,
      missRateMax: config.replay.missRateMax,
      keySchemaVersion: config.replay.keySchemaVersion
    },
    evaluationSettings: {
      timeoutMs: config.evaluation.timeoutMs,
      minimumHoldoutSamples: config.evaluation.minimumHoldoutSamples,
      splitConfig,
      holdoutGate: {
        ...DEFAULT_HOLDOUT_GATE_CONFIG,
        minimumPassRatio: config.evolution.minimumPassRatio,
        minimumImprovement: config.evolution.minimumImprovement,
        minimumHoldoutSamples: config.evaluation.minimumHoldoutSamples,
        maxMissRate: config.replay.missRateMax
      }
    },
    capabilityProfile,
    guard,
    audit,
    evolutionLock: new SingleWriterLock(config.operations.evolutionLock, config.operations.jobLeaseMs),
    deploymentLock: new SingleWriterLock(config.operations.deploymentLock, config.operations.jobLeaseMs),
    dispose() {
      if (disposed) return;
      disposed = true;
      // Sessions before storage: an environment left holding a pose is the
      // failure that outlives the process.
      adapter.releaseAllSessions();
      guard.releaseAllSessions();
      sqlite?.close();
    }
  };
}
