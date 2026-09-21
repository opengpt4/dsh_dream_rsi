import type { Context } from '@deepseek-ai/cordis';

import { resolveDreamRsiConfig, type DreamRsiConfig, type DreamRsiConfigInput } from '../config.js';
import { MockEmbodiedBackend } from '../embodied/backend.js';
import { createPerceiveTool } from '../embodied/perceive.js';
import { createActTool } from '../embodied/act.js';
import { createQueryStateTool } from '../embodied/query-state.js';
import { createStatusTool } from '../status.js';
import '../embodied/events.js';

/**
 * Cordis-specific plugin entrypoint. This module is the only place that
 * touches `ctx.effect`/`ctx.tools`; every other module receives plain
 * TypeScript interfaces so core logic stays testable without Cordis.
 */
export function apply(ctx: Context, input?: DreamRsiConfigInput): void {
  const config = resolveDreamRsiConfig(input);
  if (!config.enabled) return;
  mountTools(ctx, config);
}

function mountTools(ctx: Context, config: DreamRsiConfig): void {
  ctx.effect(() => {
    const backend = new MockEmbodiedBackend();
    const disposers = [
      ctx.tools.register(createPerceiveTool(backend)),
      ctx.tools.register(createActTool(ctx, backend)),
      ctx.tools.register(createQueryStateTool(backend)),
      ctx.tools.register(createStatusTool(config))
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'dream-rsi/tools');
}
