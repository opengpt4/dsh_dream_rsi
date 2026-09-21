import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { EnvironmentAdapter, Observation } from './protocol.js';

interface PerceiveArgs {
  readonly session_id: string;
  /** Sensors to read. Defaults to every sensor the profile declares. */
  readonly sensor_types?: readonly string[];
  readonly include_objects?: boolean;
  readonly include_pose?: boolean;
}

interface PerceiveResult {
  readonly session_id: string;
  readonly environment_id: string;
  /** The frame every position below is expressed in. */
  readonly frame_id: string;
  readonly schema_version: number;
  readonly step: number;
  /** Absent when the caller excluded the pose or asked for other sensors only. */
  readonly pose?: Observation['pose'];
  /** Absent when the caller excluded objects or asked for other sensors only. */
  readonly objects?: Array<{
    id: string;
    label: string;
    position: number[];
  }>;
  readonly timestamp: string;
}

export function createPerceiveTool(adapter: EnvironmentAdapter) {
  return defineTool({
    name: 'embodied_perceive',
    description: 'Observe the current state of the embodied environment.',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'Stable session identifier for isolated environment state.'
      },
      sensor_types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sensors to read. A sensor the capability profile does not declare is refused.'
      },
      include_objects: {
        type: 'boolean',
        description: 'Whether to include detected objects. Defaults to true.'
      },
      include_pose: {
        type: 'boolean',
        description: 'Whether to include the pose. Defaults to true.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          environment_id: { type: 'string', required: true },
          // Without the frame, a pose is an ambiguous triple of numbers.
          frame_id: { type: 'string', required: true },
          schema_version: { type: 'integer', required: true },
          step: { type: 'integer', required: true },
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
          objects: {
            type: 'array',
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

      const declared = adapter.capability().sensors;
      const requested = args.sensor_types ?? declared;
      // A backend must declare what it can sense before it can be asked for it;
      // reading an undeclared sensor would return whatever the SDK defaults to.
      const undeclared = requested.filter((sensor) => !declared.includes(sensor));
      if (undeclared.length > 0) {
        throw new Error(
          `sensor(s) not declared by the capability profile: ${undeclared.join(', ')}; declared sensors are ${declared.join(', ')}`
        );
      }

      const wantsPose = requested.includes('pose') && args.include_pose !== false;
      const wantsObjects = requested.includes('objects') && args.include_objects !== false;

      const observation = await adapter.observe({
        sessionId: args.session_id,
        correlationId: exec.callId,
        includeObjects: wantsObjects
      });

      return {
        session_id: observation.sessionId,
        environment_id: observation.environmentId,
        frame_id: observation.frameId,
        schema_version: observation.schemaVersion,
        step: observation.step,
        ...(wantsPose ? { pose: { ...observation.pose } } : {}),
        ...(wantsObjects
          ? {
              objects: observation.objects.map((object) => ({
                id: object.id,
                label: object.label,
                position: [...object.position]
              }))
            }
          : {}),
        timestamp: observation.timestamp
      };
    }
  });
}
