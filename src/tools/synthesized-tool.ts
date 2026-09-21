import { createHash } from 'node:crypto';

import type { JsonObject } from '../discovery/models.js';
import { EMBODIED_ACTION_TYPES, type EmbodiedActionType } from '../embodied/protocol.js';
import { canonicalJson, hashJson } from '../hash.js';
import type { ToolPattern } from './subgraph.js';

/**
 * A synthesized tool artifact.
 *
 * Every field a reviewer needs is part of the artifact and part of its id:
 * schema, source, tests, dependencies, and the permissions it may use.
 */

export const SYNTHESIZED_TOOL_SCHEMA_VERSION = 1;

/**
 * Permission a synthesized tool may hold.
 *
 * Only high-level action primitives are expressible. Joint velocity, raw motor
 * commands, and unwrapped hardware channels have no representation here, so a
 * tool cannot request them.
 */
export type ToolPermission = `action:${EmbodiedActionType}`;

export const ALLOWED_TOOL_PERMISSIONS: readonly ToolPermission[] = EMBODIED_ACTION_TYPES.map(
  (actionType) => `action:${actionType}` as ToolPermission
);

export type ToolOrigin = 'host-template' | 'evolution-agent';

export interface SynthesizedTool {
  /** SHA-256 over the artifact body, excluding `createdAt`. */
  readonly toolId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly source: string;
  readonly tests: string;
  readonly dependencies: readonly string[];
  readonly permissions: readonly ToolPermission[];
  /** Where the source came from. Only a template is trusted without a sandbox. */
  readonly origin: ToolOrigin;
  readonly patternSignature: string;
  readonly createdAt: string;
}

export function assertPermissionsAllowed(permissions: readonly string[]): readonly ToolPermission[] {
  const unknown = permissions.filter((permission) => !(ALLOWED_TOOL_PERMISSIONS as readonly string[]).includes(permission));
  if (unknown.length > 0) {
    throw new Error(
      `tool permission(s) not permitted: ${unknown.join(', ')}; permitted permissions are ${ALLOWED_TOOL_PERMISSIONS.join(', ')}`
    );
  }
  return [...new Set(permissions)] as readonly ToolPermission[];
}

function toolBody(tool: Omit<SynthesizedTool, 'createdAt' | 'toolId'>): Record<string, unknown> {
  return {
    schemaVersion: SYNTHESIZED_TOOL_SCHEMA_VERSION,
    name: tool.name,
    version: tool.version,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    sourceHash: createHash('sha256').update(tool.source).digest('hex'),
    testsHash: createHash('sha256').update(tool.tests).digest('hex'),
    dependencies: [...tool.dependencies],
    permissions: [...tool.permissions],
    origin: tool.origin,
    patternSignature: tool.patternSignature
  };
}

export function verifySynthesizedTool(tool: SynthesizedTool): boolean {
  return tool.toolId === hashJson(toolBody(tool) as never);
}

/** Everything except the id, which is derived. */
export type SynthesizedToolInput = Omit<SynthesizedTool, 'toolId' | 'createdAt'> & {
  readonly createdAt?: string;
};

/**
 * Build an artifact from an explicit body.
 *
 * The template synthesizer uses this, and so does any other source of tools: a
 * model-authored tool enters through the same constructor and therefore the
 * same id and verification rules.
 */
export function createSynthesizedTool(input: SynthesizedToolInput): SynthesizedTool {
  const permissions = assertPermissionsAllowed(input.permissions);
  const body = {
    name: input.name,
    version: input.version,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    source: input.source,
    tests: input.tests,
    dependencies: [...input.dependencies],
    permissions,
    origin: input.origin,
    patternSignature: input.patternSignature
  };
  if (body.name.trim().length === 0) throw new Error('tool name must not be empty');
  if (body.source.trim().length === 0) throw new Error('tool source must not be empty');
  if (body.tests.trim().length === 0) throw new Error('tool tests must not be empty');
  return {
    toolId: hashJson(toolBody(body) as never),
    ...body,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

export interface SynthesizeToolOptions {
  readonly version?: string;
  readonly origin?: ToolOrigin;
  readonly createdAt?: string;
}

/**
 * Turn a mined pattern into a tool artifact.
 *
 * Template synthesis: the generated module replays the validated action
 * sequence through an `EnvironmentAdapter`. It imports nothing, so it already
 * satisfies the dependency allowlist, and it holds only the action permissions
 * its steps use.
 */
export function synthesizeTool(pattern: ToolPattern, options: SynthesizeToolOptions = {}): SynthesizedTool {
  if (pattern.steps.length === 0) throw new Error('cannot synthesize a tool from an empty pattern');
  const origin = options.origin ?? 'host-template';
  const version = options.version ?? '1.0.0';
  const permissions = assertPermissionsAllowed([
    ...new Set(pattern.steps.map((step) => `action:${step.actionType}`))
  ]);
  const name = toolName(pattern);
  const description = `Replays a ${pattern.steps.length}-step sequence observed ${pattern.supportingNodeIds.length} time(s): ${pattern.signature}`;

  const body = {
    name,
    version,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        episode_id: { type: 'string' },
        timeout_ms: { type: 'integer' }
      }
    } satisfies JsonObject,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'failed_at', 'steps'],
      properties: {
        ok: { type: 'boolean' },
        failed_at: { type: ['integer', 'null'] },
        steps: { type: 'integer' }
      }
    } satisfies JsonObject,
    source: toolSource(pattern, name),
    tests: toolTests(name),
    dependencies: [],
    permissions,
    origin,
    patternSignature: pattern.signature
  };

  return createSynthesizedTool(body);
}

/** Stable per action-type sequence, so two variants of one macro share a name and differ by version. */
function toolName(pattern: ToolPattern): string {
  const slug = [...new Set(pattern.steps.map((step) => step.actionType))].join('_');
  return `macro_${slug}`;
}

function toolSource(pattern: ToolPattern, name: string): string {
  const steps = pattern.steps
    .map((step) => `  { actionType: ${JSON.stringify(step.actionType)}, parameters: ${canonicalJson(step.actionParams)} }`)
    .join(',\n');

  return `// Synthesized tool ${name}, version 1.0.0.
// Generated from a pattern observed in successful trajectories. It imports
// nothing and performs only high-level action primitives.

export const steps = Object.freeze([
${steps}
]);

export async function run(adapter, sessionId, options = {}) {
  const results = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const result = await adapter.execute(
      {
        actionId: \`\${options.episodeId ?? 'tool'}:\${index}\`,
        sessionId,
        correlationId: options.correlationId ?? 'tool',
        actionType: step.actionType,
        parameters: step.parameters,
        timeoutMs: options.timeoutMs ?? 30000,
        requestedAt: new Date().toISOString()
      },
      options.signal
    );
    results.push(result);
    if (result.status !== 'completed') return { ok: false, failedAt: index, steps: results.length };
  }
  return { ok: true, failedAt: null, steps: results.length };
}
`;
}

function toolTests(name: string): string {
  return `import assert from 'node:assert/strict';
import { run, steps } from './tool.mjs';

function adapter(statuses) {
  let index = 0;
  return {
    calls: [],
    async execute(request) {
      const status = statuses[index] ?? 'completed';
      index += 1;
      this.calls.push(request);
      return {
        actionId: request.actionId,
        status,
        step: index,
        pose: { x: 0, y: 0, z: 0, yaw: 0 },
        gripper: 'open',
        message: status,
        execTimeMs: 0,
        completedAt: new Date().toISOString()
      };
    }
  };
}

const succeeding = adapter([]);
const ok = await run(succeeding, 'session-1');
assert.equal(ok.ok, true);
assert.equal(ok.failedAt, null);
assert.equal(succeeding.calls.length, steps.length);
assert.deepEqual(succeeding.calls.map((call) => call.actionType), steps.map((step) => step.actionType));

const failing = adapter(steps.map((_, index) => (index === 0 ? 'failed' : 'completed')));
const stopped = await run(failing, 'session-2');
assert.equal(stopped.ok, false);
assert.equal(stopped.failedAt, 0);
assert.equal(failing.calls.length, 1);

console.log(JSON.stringify({ passed: true, tool: ${JSON.stringify(name)}, assertions: 5 }));
`;
}
