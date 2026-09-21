import { apply } from './adapter/cordis.js';

export { InMemoryDiscoveryStore } from './discovery/models.js';
export { SQLiteDiscoveryStore } from './discovery/sqlite-store.js';
export { createReplayKey, REPLAY_KEY_SCHEMA_VERSION } from './replay/key.js';
export { ReplaySimulator } from './replay/simulator.js';
export { evaluateReplay, DEFAULT_EVALUATOR_CONFIG } from './evolution/evaluator.js';
export { evaluateReplayIsolated } from './evolution/isolated-evaluator.js';
export { splitDiscoveryNodes, DEFAULT_SPLIT_CONFIG } from './evolution/split.js';
export { evaluateMonotonicGate, DEFAULT_MONOTONIC_GATE_CONFIG } from './evolution/monotonic-gate.js';
export { createEvaluationSnapshot } from './evolution/snapshot.js';
export { SingleWriterLock } from './operations/single-writer-lock.js';
export { runAstGuard, type AstGuardResult, type AstGuardViolation } from './guardrails/ast-guard.js';
export { getDreamRsiStatus, createStatusTool, type DreamRsiStatus } from './status.js';
export {
  DEFAULT_DREAM_RSI_CONFIG,
  resolveDreamRsiConfig,
  validateDreamRsiConfig,
  type DreamRsiConfig,
  type DreamRsiConfigInput
} from './config.js';

export const name = 'dream-rsi';
export const inject: string[] = [];

/**
 * Cordis entrypoint for the Dream-RSI plugin. All Cordis-specific wiring
 * lives in `adapter/cordis.ts` so the rest of the package stays testable
 * without a Cordis context.
 */
export { apply };

