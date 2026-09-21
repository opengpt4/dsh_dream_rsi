import type { Context } from '@deepseek-ai/cordis';

import { resolveDreamRsiConfig, type DreamRsiConfig, type DreamRsiConfigInput } from '../config.js';
import { createPerceiveTool } from '../embodied/perceive.js';
import { createActTool } from '../embodied/act.js';
import { createQueryStateTool } from '../embodied/query-state.js';
import { createStatusTool } from '../status.js';
import { createDreamRsiRuntime } from '../runtime.js';
import '../embodied/events.js';

/**
 * Cordis-specific plugin entrypoint. This module is the only place that
 * touches `ctx.effect`/`ctx.tools`; every other module receives plain
 * TypeScript interfaces so core logic stays testable without Cordis.
 *
 * Config is resolved and validated before the effect is registered, so an
 * invalid config fails the load without registering a tool or creating the
 * SQLite file.
 */
export function apply(ctx: Context, input?: DreamRsiConfigInput): void {
  const config = resolveDreamRsiConfig(input);
  if (!config.enabled) return;
  mountTools(ctx, config);
}

function mountTools(ctx: Context, config: DreamRsiConfig): void {
  ctx.effect(() => {
    const runtime = createDreamRsiRuntime(config);
    const disposers: Array<() => void> = [];
    const rollback = (): void => {
      for (const dispose of disposers.reverse()) dispose();
      runtime.dispose();
    };

    // A failure partway through registration leaves the effect with no disposer,
    // so the already-registered tools and the runtime would leak. Roll back here
    // instead of relying on the caller.
    try {
      disposers.push(ctx.tools.register(createPerceiveTool(runtime.adapter)));
      disposers.push(ctx.tools.register(createActTool(ctx, runtime.adapter, runtime.guard)));
      disposers.push(ctx.tools.register(createQueryStateTool(runtime.adapter)));
      disposers.push(ctx.tools.register(createStatusTool(config, runtime)));
    } catch (error) {
      rollback();
      throw error;
    }

    return rollback;
  }, 'dream-rsi/tools');
}
