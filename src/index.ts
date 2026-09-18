import type { Context } from '@deepseek-ai/cordis';

import { createPerceiveTool } from './embodied/perceive.js';
import { MockEmbodiedBackend } from './embodied/backend.js';
import { createActTool } from './embodied/act.js';
import { createQueryStateTool } from './embodied/query-state.js';
import './embodied/events.js';

export const name = 'dream-rsi';
export const inject: string[] = [];

/**
 * Cordis entrypoint for the Dream-RSI plugin.
 *
 * Capability registration is intentionally deferred until the DSH tool and
 * event contracts are pinned in the next implementation phase.
 */
export function apply(ctx: Context): void {
  const backend = new MockEmbodiedBackend();
  ctx.tools.register(createPerceiveTool(backend));
  ctx.tools.register(createActTool(ctx, backend));
  ctx.tools.register(createQueryStateTool(backend));
}
