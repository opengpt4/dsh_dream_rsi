import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { EnvironmentAdapter } from './protocol.js';

interface QueryArgs {
  readonly session_id: string;
  readonly query: string;
}

export function createQueryStateTool(adapter: EnvironmentAdapter) {
  return defineTool({
    name: 'embodied_query_state',
    description: 'Query compact world state from the mock embodied environment.',
    parameters: {
      session_id: { type: 'string', required: true },
      query: { type: 'string', required: true, description: 'Use objects, pose, or gripper.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          query: { type: 'string', required: true },
          value: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              objects: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    label: { type: 'string', required: true },
                    position: { type: 'array', items: { type: 'number' }, required: true }
                  }
                }
              },
              pose: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  x: { type: 'number', required: true },
                  y: { type: 'number', required: true },
                  z: { type: 'number', required: true },
                  yaw: { type: 'number', required: true }
                }
              },
              gripper: { type: 'string' }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args: QueryArgs, exec: ToolRunContext) {
      if (exec.signal.aborted) throw new Error('state query was cancelled');
      // Validated before the read, as `embodied_perceive` validates its sensor
      // list first: observing is what opens or creates the session in a backend,
      // so rejecting an unanswerable query afterwards left environment state
      // behind for a request that could never be answered.
      if (args.query !== 'objects' && args.query !== 'pose' && args.query !== 'gripper') {
        throw new Error('query must be one of: objects, pose, gripper');
      }
      // `observe` is the only environment read, so this tool needs nothing the
      // adapter contract does not already provide.
      const state = await adapter.observe({
        sessionId: args.session_id,
        correlationId: exec.callId,
        includeObjects: true
      });
      const value = args.query === 'objects'
        ? { objects: state.objects.map((object) => ({ id: object.id, label: object.label, position: [...object.position] })) }
        : args.query === 'pose'
          ? { pose: { ...state.pose } }
          : { gripper: state.gripper };
      return {
        session_id: args.session_id,
        query: args.query,
        value
      };
    }
  });
}