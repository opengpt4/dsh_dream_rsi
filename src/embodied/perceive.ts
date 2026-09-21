import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { EnvironmentAdapter, Observation } from './protocol.js';

interface PerceiveArgs {
  readonly session_id: string;
  readonly include_objects?: boolean;
}

interface PerceiveResult {
  readonly session_id: string;
  readonly environment_id: string;
  readonly step: number;
  readonly pose: Observation['pose'];
  readonly objects: Array<{
    id: string;
    label: string;
    position: number[];
  }>;
  readonly timestamp: string;
}

export function createPerceiveTool(adapter: EnvironmentAdapter) {
  return defineTool({
    name: 'embodied_perceive',
    description: 'Observe the current state of the mock embodied environment.',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'Stable session identifier for isolated environment state.'
      },
      include_objects: {
        type: 'boolean',
        description: 'Whether to include detected objects. Defaults to true.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          environment_id: { type: 'string', required: true },
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
          objects: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                position: {
                  type: 'array',
                  required: true,
                  items: { type: 'number' }
                }
              }
            }
          },
          timestamp: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args: PerceiveArgs, exec: ToolRunContext): Promise<PerceiveResult> {
      if (exec.signal.aborted) {
        throw new Error('embodied_perceive was cancelled before execution');
      }

      const observation = await adapter.observe({
        sessionId: args.session_id,
        correlationId: exec.callId,
        includeObjects: args.include_objects !== false
      });
      return {
        session_id: observation.sessionId,
        environment_id: observation.environmentId,
        step: observation.step,
        pose: observation.pose,
        objects: observation.objects.map((object) => ({
          id: object.id,
          label: object.label,
          position: [...object.position]
        })),
        timestamp: observation.timestamp
      };
    }
  });
}
