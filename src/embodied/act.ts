import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { EmbodiedActionType, MockActionResult, MockEmbodiedBackend } from './backend.js';
import { EMBODIED_ACTION_TYPES } from './protocol.js';

export function createActTool(ctx: Context, backend: MockEmbodiedBackend) {
  return defineTool({
    name: 'embodied_act',
    description: 'Execute an allowlisted high-level action in the mock embodied environment.',
    parameters: {
      session_id: { type: 'string', required: true },
      action_type: { type: 'string', required: true },
      parameters: { type: 'object', additionalProperties: true, properties: {} },
      timeout_ms: { type: 'integer' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          action_id: { type: 'string', required: true },
          result: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action_type: { type: 'string', required: true },
              step: { type: 'integer', required: true },
              pose: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  x: { type: 'number', required: true },
                  y: { type: 'number', required: true },
                  z: { type: 'number', required: true },
                  yaw: { type: 'number', required: true }
                }
              },
              gripper: { type: 'string', required: true },
              message: { type: 'string', required: true }
            }
          },
          error: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    timeoutMs: 30000,
    async execute(args, exec: ToolRunContext) {
      const actionId = `${args.session_id}:${exec.callId}`;
      if (!EMBODIED_ACTION_TYPES.includes(args.action_type as EmbodiedActionType)) {
        const error = `action ${args.action_type} is not allowed`;
        ctx.emit('embodied/error', { actionId, sessionId: args.session_id, error });
        return { success: false, action_id: actionId, error };
      }
      if (exec.signal.aborted) {
        const error = 'action cancelled before execution';
        ctx.emit('embodied/error', { actionId, sessionId: args.session_id, error });
        return { success: false, action_id: actionId, error };
      }

      const actionType = args.action_type as EmbodiedActionType;
      ctx.emit('embodied/action-started', { actionId, sessionId: args.session_id, actionType });
      try {
        const result = await executeWithTimeout(
          (signal) => backend.execute(args.session_id, actionType, args.parameters ?? {}, signal),
          args.timeout_ms ?? 30000,
          exec.signal
        );
        ctx.emit('embodied/action-completed', { actionId, sessionId: args.session_id, result });
        ctx.emit('embodied/frame', { sessionId: args.session_id, step: result.step });
        return {
          success: true,
          action_id: actionId,
          result: {
            action_type: result.actionType,
            step: result.step,
            pose: { ...result.pose },
            gripper: result.gripper,
            message: result.message
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.emit('embodied/error', { actionId, sessionId: args.session_id, error: message });
        return { success: false, action_id: actionId, error: message };
      }
    }
  });
}

function executeWithTimeout(
  operation: (signal: AbortSignal) => Promise<MockActionResult>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<MockActionResult> {
  if (signal.aborted) return Promise.reject(new Error('action cancelled'));

  const combinedController = new AbortController();
  const onCallerAbort = (): void => combinedController.abort();
  signal.addEventListener('abort', onCallerAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    combinedController.abort();
  }, timeoutMs);

  return operation(combinedController.signal).then(
    (result) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onCallerAbort);
      return result;
    },
    (error: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onCallerAbort);
      if (timedOut) throw new Error('action timed out');
      if (signal.aborted) throw new Error('action cancelled');
      throw error;
    }
  );
}
