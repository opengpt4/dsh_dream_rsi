import type { Context } from '@deepseek-ai/cordis';

import { createPerceiveTool } from './embodied/perceive.js';
import { MockEmbodiedBackend } from './embodied/backend.js';
import { createActTool } from './embodied/act.js';
import { createQueryStateTool } from './embodied/query-state.js';
import './embodied/events.js';

export { InMemoryDiscoveryStore } from './discovery/models.js';
export { SQLiteDiscoveryStore } from './discovery/sqlite-store.js';
export { createReplayKey, REPLAY_KEY_SCHEMA_VERSION } from './replay/key.js';
export { ReplaySimulator } from './replay/simulator.js';
export { evaluateReplay, DEFAULT_EVALUATOR_CONFIG } from './evolution/evaluator.js';
export { splitDiscoveryNodes, DEFAULT_SPLIT_CONFIG } from './evolution/split.js';
export { evaluateMonotonicGate, DEFAULT_MONOTONIC_GATE_CONFIG } from './evolution/monotonic-gate.js';
export { createEvaluationSnapshot } from './evolution/snapshot.js';
export { SingleWriterLock } from './operations/single-writer-lock.js';

export const name = 'dream-rsi';
export const inject: string[] = [];

/**
 * Cordis entrypoint for the Dream-RSI plugin.
 *
 * Capability registration is intentionally deferred until the DSH tool and
 * event contracts are pinned in the next implementation phase.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const backend = new MockEmbodiedBackend();
    const disposers = [
      ctx.tools.register(createPerceiveTool(backend)),
      ctx.tools.register(createActTool(ctx, backend)),
      ctx.tools.register(createQueryStateTool(backend))
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'dream-rsi/tools');
}
