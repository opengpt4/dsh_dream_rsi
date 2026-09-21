import { validateDreamRsiConfig, type DreamRsiConfig } from './config.js';
import { InMemoryDiscoveryStore, type DiscoveryStore } from './discovery/models.js';
import { SQLiteDiscoveryStore } from './discovery/sqlite-store.js';
import { MockEmbodiedBackend } from './embodied/backend.js';
import { MockEnvironmentAdapter } from './embodied/mock-adapter.js';
import { DEFAULT_SPLIT_CONFIG, type EvaluationSplitConfig } from './evolution/split.js';
import { SingleWriterLock } from './operations/single-writer-lock.js';

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
  readonly evolutionLock: SingleWriterLock;
  readonly deploymentLock: SingleWriterLock;
  /** Releases every resource this runtime owns. Safe to call more than once. */
  dispose(): void;
}

/**
 * Build the runtime for one config.
 *
 * Validates before constructing anything: an invalid config must throw rather
 * than create the SQLite file or hand back a partially-built runtime.
 *
 * The store is built on first access. Opening it is what creates the database
 * file and its parent directory, and mounting the plugin must not write to the
 * host filesystem before anything reads a Discovery node.
 */
export function createDreamRsiRuntime(config: DreamRsiConfig): DreamRsiRuntime {
  validateDreamRsiConfig(config);

  let disposed = false;
  let sqlite: SQLiteDiscoveryStore | undefined;
  let store: DiscoveryStore | undefined;
  const backend = new MockEmbodiedBackend();
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
    adapter: new MockEnvironmentAdapter(backend),
    splitConfig,
    replaySettings: {
      maxNodes: config.replay.maxNodes,
      missRateMax: config.replay.missRateMax,
      keySchemaVersion: config.replay.keySchemaVersion
    },
    evaluationSettings: {
      timeoutMs: config.evaluation.timeoutMs,
      minimumHoldoutSamples: config.evaluation.minimumHoldoutSamples,
      splitConfig
    },
    evolutionLock: new SingleWriterLock(config.operations.evolutionLock, config.operations.jobLeaseMs),
    deploymentLock: new SingleWriterLock(config.operations.deploymentLock, config.operations.jobLeaseMs),
    dispose() {
      if (disposed) return;
      disposed = true;
      sqlite?.close();
    }
  };
}
