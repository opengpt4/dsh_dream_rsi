import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { ActionGuard } from '../safety/action-guard.js';
import type { EmbodiedActionType, EnvironmentAdapter } from './protocol.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `embodied_act` dispatches through the action guard, so an interactive action
 * obeys the same capability profile, confirmation, rate limit, lease, and state
 * machine as one taken by an episode. A rejected action returns a tool error
 * carrying the rejection code and never reaches the backend.
 *
 * `state` is the state-machine state; `status` is the terminal action outcome.
 */
export function createActTool(ctx: Context, adapter: EnvironmentAdapter, guard: ActionGuard) {
  return defineTool({
    name: 'embodied_act',
    description: 'Execute an allowlisted high-level action in the mock embodied environment.',
    parameters: {
      session_id: { type: 'string', required: true },
      action_type: { type: 'string', required: true },
      parameters: { type: 'object', additionalProperties: true, properties: {} },
      timeout_ms: { type: 'integer' },
      confirmation_token: {
        type: 'string',
        description: 'Required for actions whose capability declares requiresConfirmation.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          action_id: { type: 'string', required: true },
          state: { type: 'string', required: true },
          status: { type: 'string', required: true },
          result: {
            type: 'object',
            additionalProperties: false,
            properties: {
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
          error: { type: 'string' },
          rejection_code: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    timeoutMs: 30_000,
    async execute(args, exec: ToolRunContext) {
      const actionId = `${args.session_id}:${exec.callId}`;
      const actionType = args.action_type as EmbodiedActionType;
      const parameters = args.parameters ?? {};
      const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const requestedAt = new Date().toISOString();

      // A call the caller already abandoned reads nothing and announces nothing.
      // Observing is what opens or creates the session in a backend, so checking
      // after it left environment state behind for an action cancelled before it
      // began, and emitting `action-started` first left a host holding a start
      // it could never pair with a terminal event.
      if (exec.signal.aborted) {
        return {
          success: false,
          action_id: actionId,
          state: 'CANCELLED',
          status: 'cancelled',
          error: 'action was cancelled before dispatch'
        };
      }

      ctx.emit('embodied/action-started', { actionId, sessionId: args.session_id, actionType });

      // An action is expressed in the frame of the state it was decided from, so
      // the frame comes from the environment rather than from the caller.
      const observation = await adapter.observe({
        sessionId: args.session_id,
        correlationId: actionId,
        includeObjects: false
      });

      const record = await guard.execute(
        {
          actionId,
          idempotencyKey: actionId,
          sessionId: args.session_id,
          correlationId: actionId,
          actionType,
          parameters,
          frameId: observation.frameId,
          timeoutMs,
          requestedAt,
          ...(args.confirmation_token !== undefined ? { confirmationToken: args.confirmation_token } : {})
        },
        (signal) =>
          adapter.execute(
            { actionId, sessionId: args.session_id, correlationId: actionId, actionType, parameters, timeoutMs, requestedAt },
            signal
          ),
        exec.signal
      );

      const result = record.result;
      if (result === undefined) {
        const message = record.rejection?.reason ?? 'action was not authorized';
        ctx.emit('embodied/error', { actionId, sessionId: args.session_id, error: message });
        return {
          success: false,
          action_id: actionId,
          state: record.state,
          status: 'failed',
          error: message,
          ...(record.rejection !== undefined ? { rejection_code: record.rejection.code } : {})
        };
      }

      if (result.status === 'completed') {
        ctx.emit('embodied/action-completed', { actionId, sessionId: args.session_id, result });
        ctx.emit('embodied/frame', { sessionId: args.session_id, step: result.step });
      } else {
        ctx.emit('embodied/error', {
          actionId,
          sessionId: args.session_id,
          error: result.error ?? result.message
        });
      }

      return {
        success: result.status === 'completed',
        action_id: actionId,
        state: record.state,
        status: result.status,
        result: {
          step: result.step,
          pose: { ...result.pose },
          gripper: result.gripper,
          message: result.message
        },
        ...(result.status === 'completed' ? {} : { error: result.error ?? result.message })
      };
    }
  });
}
