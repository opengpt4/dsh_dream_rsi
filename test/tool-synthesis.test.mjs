import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_TOOL_PERMISSIONS,
  DynamicToolRegistry,
  ProcessToolTestRunner,
  assertPermissionsAllowed,
  createSynthesizedTool,
  mineSuccessfulPatterns,
  runToolGates,
  synthesizeTool,
  verifySynthesizedTool
} from '../dist/index.js';

const MOVE = { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } };
const PICK = { actionType: 'pick', parameters: { objectId: 'red-mug' } };

function node({ taskId, nodeId, parentId = null, step, status = 'completed' }) {
  return {
    nodeId,
    taskId,
    parentId,
    policyVersion: 'policy-v1',
    environmentVersion: 'mock-room-v1@1',
    stateHash: `state-${nodeId}`,
    observationHash: `obs-${nodeId}`,
    actionType: step.actionType,
    actionParams: step.parameters,
    result: { actionId: nodeId, status },
    score: 1,
    tokenCost: 0,
    execTimeMs: 1,
    idempotencyKey: nodeId,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

/** One linear episode from an ordered list of steps. */
function episode(taskId, prefix, steps) {
  const nodes = [];
  let parentId = null;
  steps.forEach((step, index) => {
    const nodeId = `${prefix}-${index}`;
    nodes.push(node({ taskId, nodeId, parentId, step, ...(step.status !== undefined ? { status: step.status } : {}) }));
    parentId = nodeId;
  });
  return nodes;
}

// ------------------------------------------------------------------ mining

test('a sequence repeated across two successful episodes becomes a pattern', () => {
  const nodes = [...episode('task-a', 'a', [MOVE, PICK]), ...episode('task-b', 'b', [MOVE, PICK])];
  const patterns = mineSuccessfulPatterns(nodes);

  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0].steps.map((step) => step.actionType), ['move_relative', 'pick']);
  assert.deepEqual(patterns[0].supportingNodeIds, ['a-0', 'b-0']);
  assert.deepEqual(patterns[0].tasks, ['task-a', 'task-b']);
  assert.equal(patterns[0].signature, 'move_relative({"dx":1,"dy":0,"dz":0})->pick({"objectId":"red-mug"})');
});

test('a sequence containing a failed step is not offered as a tool', () => {
  const failing = [MOVE, { ...PICK, status: 'failed' }];
  const nodes = [...episode('task-a', 'a', failing), ...episode('task-b', 'b', failing)];

  assert.deepEqual(mineSuccessfulPatterns(nodes), []);
});

test('a failure splits the run rather than being skipped over', () => {
  const nodes = [
    ...episode('task-a', 'a', [MOVE, { ...PICK, status: 'failed' }, MOVE, PICK]),
    ...episode('task-b', 'b', [MOVE, PICK])
  ];
  const patterns = mineSuccessfulPatterns(nodes);

  // Only the two-step move->pick run counts; the sequence spanning the failure
  // must not be treated as contiguous.
  assert.deepEqual(patterns.map((pattern) => pattern.steps.length), [2]);
  assert.deepEqual(patterns[0].supportingNodeIds, ['a-2', 'b-0']);
});

test('occurrences below the threshold are excluded', () => {
  const nodes = episode('task-a', 'a', [MOVE, PICK]);

  assert.deepEqual(mineSuccessfulPatterns(nodes), []);
  assert.equal(mineSuccessfulPatterns(nodes, { minOccurrences: 1 }).length, 1);
});

test('the pattern signature is canonical, so parameter key order does not matter', () => {
  const reordered = { actionType: 'move_relative', parameters: { dz: 0, dy: 0, dx: 1 } };
  const nodes = [...episode('task-a', 'a', [MOVE, PICK]), ...episode('task-b', 'b', [reordered, PICK])];

  const patterns = mineSuccessfulPatterns(nodes);
  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0].supportingNodeIds, ['a-0', 'b-0']);
});

test('minSteps and maxSteps bound the windows considered', () => {
  const steps = [MOVE, PICK, MOVE];
  const nodes = [...episode('task-a', 'a', steps), ...episode('task-b', 'b', steps)];

  assert.deepEqual(mineSuccessfulPatterns(nodes, { minSteps: 3 }).map((p) => p.steps.length), [3]);
  assert.deepEqual(
    mineSuccessfulPatterns(nodes, { minSteps: 1, maxSteps: 1 }).map((p) => p.steps.length),
    [1, 1]
  );
  assert.throws(() => mineSuccessfulPatterns(nodes, { minSteps: 0 }), /minSteps must be a positive integer/);
  assert.throws(() => mineSuccessfulPatterns(nodes, { minSteps: 3, maxSteps: 2 }), /maxSteps must be at least minSteps/);
});

// --------------------------------------------------------------- synthesis

test('a mined pattern becomes a complete tool artifact', () => {
  const pattern = mineSuccessfulPatterns([
    ...episode('task-a', 'a', [MOVE, PICK]),
    ...episode('task-b', 'b', [MOVE, PICK])
  ])[0];
  const tool = synthesizeTool(pattern);

  assert.equal(tool.name, 'macro_move_relative_pick');
  assert.equal(tool.version, '1.0.0');
  assert.equal(tool.origin, 'host-template');
  assert.match(tool.toolId, /^[0-9a-f]{64}$/);
  assert.equal(verifySynthesizedTool(tool), true);
  assert.deepEqual(tool.permissions, ['action:move_relative', 'action:pick']);
  // The generated module imports nothing, so the dependency allowlist is clean.
  assert.deepEqual(tool.dependencies, []);
  assert.match(tool.source, /export async function run/);
  assert.match(tool.tests, /node:assert\/strict/);
  assert.equal(tool.inputSchema.required[0], 'session_id');
  assert.equal(tool.outputSchema.required[0], 'ok');
});

test('the tool id covers the source, tests, permissions, and version', () => {
  const pattern = mineSuccessfulPatterns([
    ...episode('task-a', 'a', [MOVE, PICK]),
    ...episode('task-b', 'b', [MOVE, PICK])
  ])[0];
  const base = synthesizeTool(pattern);

  assert.notEqual(synthesizeTool(pattern, { version: '2.0.0' }).toolId, base.toolId);
  assert.equal(synthesizeTool(pattern, { createdAt: '2030-01-01T00:00:00.000Z' }).toolId, base.toolId);
  assert.equal(verifySynthesizedTool({ ...base, source: `${base.source}\n// tampered` }), false);
  assert.equal(verifySynthesizedTool({ ...base, permissions: ['action:pick'] }), false);
});

test('only high-level action permissions are expressible', () => {
  assert.deepEqual(assertPermissionsAllowed(['action:move_relative']), ['action:move_relative']);
  assert.equal(ALLOWED_TOOL_PERMISSIONS.length, 5);

  for (const forbidden of ['joint-velocity', 'raw-motor', 'action:teleport', 'hardware']) {
    assert.throws(() => assertPermissionsAllowed([forbidden]), /not permitted/);
  }
});

function customTool(overrides = {}) {
  return createSynthesizedTool({
    name: 'custom_macro',
    version: '1.0.0',
    description: 'test fixture',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    source: 'export const noop = () => 1;',
    tests: "import assert from 'node:assert/strict';\nassert.equal(1, 1);\nconsole.log(JSON.stringify({ passed: true }));\n",
    dependencies: [],
    permissions: ['action:move_relative'],
    origin: 'host-template',
    patternSignature: 'custom',
    ...overrides
  });
}

// ------------------------------------------------------------------- gates

test('a host-synthesized tool passes every gate, including its own tests', async () => {
  const pattern = mineSuccessfulPatterns([
    ...episode('task-a', 'a', [MOVE, PICK]),
    ...episode('task-b', 'b', [MOVE, PICK])
  ])[0];
  const tool = synthesizeTool(pattern);

  const result = await runToolGates(tool, { runner: new ProcessToolTestRunner({ timeoutMs: 20_000 }) });

  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.guardResults.map((guard) => guard.guard), [
    'astGuard',
    'dependencyAllowlist',
    'capabilityGuard',
    'testSourceGuards',
    'isolatedTests'
  ]);
  assert.ok(result.guardResults.every((guard) => guard.passed));
});

test('a tool that reaches for the filesystem fails the dependency and capability gates', async () => {
  const tool = customTool({ source: "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;" });

  const result = await runToolGates(tool, { runner: new ProcessToolTestRunner() });

  assert.equal(result.passed, false);
  assert.deepEqual(result.capabilities, ['filesystem']);
  // Three independent guards catch it: the AST guard's own forbidden-module
  // list, the dependency allowlist, and the capability classification.
  const failed = result.guardResults.filter((guard) => !guard.passed).map((guard) => guard.guard);
  assert.deepEqual(failed.sort(), ['astGuard', 'capabilityGuard', 'dependencyAllowlist']);
});

test('a tool using eval fails the AST gate', async () => {
  const tool = customTool({ source: 'export const run = (payload) => eval(payload);' });

  const result = await runToolGates(tool, { runner: new ProcessToolTestRunner() });

  assert.equal(result.passed, false);
  assert.equal(result.guardResults.find((guard) => guard.guard === 'astGuard').passed, false);
});

test('a tool whose tests fail is not enabled by a passing static scan', async () => {
  const tool = customTool({
    tests: "import assert from 'node:assert/strict';\nassert.equal(1, 2);\nconsole.log(JSON.stringify({ passed: true }));\n"
  });

  const result = await runToolGates(tool, { runner: new ProcessToolTestRunner() });

  assert.equal(result.passed, false);
  const tests = result.guardResults.find((guard) => guard.guard === 'isolatedTests');
  assert.equal(tests.passed, false);
  assert.match(tests.detail, /exited with code/);
});

test('tests that never run do not count as passing', async () => {
  const tool = customTool();
  const result = await runToolGates(tool, {
    runner: {
      async run() {
        throw new Error('no runner configured');
      }
    }
  });

  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /isolatedTests: tests did not run/);
});

// ---------------------------------------------------------------- registry

function cleanGates() {
  return [{ guard: 'astGuard', passed: true }, { guard: 'isolatedTests', passed: true }];
}

function failingGates() {
  return [{ guard: 'astGuard', passed: false, detail: 'eval' }];
}

test('a proposed tool is a candidate and is not selectable', () => {
  const registry = new DynamicToolRegistry();
  const tool = customTool();
  const entry = registry.propose(tool, cleanGates());

  assert.equal(entry.status, 'candidate');
  assert.equal(registry.isSelectable(tool.toolId), false);
  assert.deepEqual(registry.selectable(), []);
  assert.equal(registry.resolve('custom_macro'), undefined);
});

test('a tool with a failed gate cannot be enabled', () => {
  const registry = new DynamicToolRegistry();
  const tool = customTool();
  registry.propose(tool, failingGates());

  assert.throws(() => registry.enable(tool.toolId, 'operator-1'), /cannot be enabled: 1 failed gate/);
  assert.equal(registry.isSelectable(tool.toolId), false);

  const ungated = customTool({ name: 'ungated' });
  registry.propose(ungated, []);
  assert.throws(() => registry.enable(ungated.toolId, 'operator-1'), /0 failed gate/);
});

test('enabling requires an operator and makes the tool selectable', () => {
  const registry = new DynamicToolRegistry();
  const tool = customTool();
  registry.propose(tool, cleanGates());

  assert.throws(() => registry.enable(tool.toolId, '  '), /requires an operator/);

  const enabled = registry.enable(tool.toolId, 'operator-1');
  assert.equal(enabled.status, 'enabled');
  assert.equal(enabled.operator, 'operator-1');
  assert.equal(registry.isSelectable(tool.toolId), true);
  assert.deepEqual(registry.selectable().map((entry) => entry.name), ['custom_macro']);
  assert.equal(registry.resolve('custom_macro').toolId, tool.toolId);
});

test('a disabled tool cannot be selected by a new task', () => {
  const registry = new DynamicToolRegistry();
  const tool = customTool();
  registry.propose(tool, cleanGates());
  registry.enable(tool.toolId, 'operator-1');

  registry.disable(tool.toolId, 'operator-1', 'caused a regression');

  // Absent, not deprioritised: a caller filtering by name gets nothing.
  assert.deepEqual(registry.selectable(), []);
  assert.equal(registry.resolve('custom_macro'), undefined);
  assert.equal(registry.isSelectable(tool.toolId), false);
  assert.equal(registry.entry(tool.toolId).reason, 'caused a regression');
});

test('enabling a new version records the one it replaced', () => {
  const registry = new DynamicToolRegistry();
  const first = customTool({ version: '1.0.0' });
  const second = customTool({ version: '2.0.0' });
  registry.propose(first, cleanGates());
  registry.propose(second, cleanGates());
  registry.enable(first.toolId, 'operator-1');

  const enabled = registry.enable(second.toolId, 'operator-1');

  assert.equal(enabled.previousToolId, first.toolId);
  assert.equal(registry.selectable().length, 2, 'the older version is still enabled until explicitly disabled');
  assert.deepEqual(registry.versions('custom_macro').map((entry) => entry.version), ['1.0.0', '2.0.0']);
});

test('rollback restores the previous version and disables the current one', () => {
  const registry = new DynamicToolRegistry();
  const first = customTool({ version: '1.0.0' });
  const second = customTool({ version: '2.0.0' });
  registry.propose(first, cleanGates());
  registry.propose(second, cleanGates());
  registry.enable(first.toolId, 'operator-1');
  registry.enable(second.toolId, 'operator-1');
  registry.disable(first.toolId, 'operator-1', 'superseded');

  const restored = registry.rollback('custom_macro', 'operator-2', 'regression in 2.0.0');

  assert.equal(restored.toolId, first.toolId);
  assert.equal(restored.status, 'enabled');
  assert.equal(registry.entry(second.toolId).status, 'disabled');
  assert.equal(registry.resolve('custom_macro').version, '1.0.0');
});

test('rollback without a previous version is refused', () => {
  const registry = new DynamicToolRegistry();
  const only = customTool();
  registry.propose(only, cleanGates());
  registry.enable(only.toolId, 'operator-1');

  assert.throws(() => registry.rollback('custom_macro', 'operator-1', 'why'), /no previous version/);
  assert.throws(() => registry.rollback('nothing_here', 'operator-1', 'why'), /no enabled tool named/);
});

test('every registry transition is recorded in order', () => {
  const registry = new DynamicToolRegistry();
  const first = customTool({ version: '1.0.0' });
  const second = customTool({ version: '2.0.0' });
  registry.propose(first, cleanGates());
  registry.propose(second, cleanGates());
  registry.enable(first.toolId, 'operator-1');
  registry.enable(second.toolId, 'operator-1');
  registry.disable(first.toolId, 'operator-1', 'superseded');
  registry.rollback('custom_macro', 'operator-2', 'regression');

  assert.deepEqual(
    registry.history().map((entry) => `${entry.version}:${entry.status}`),
    ['1.0.0:candidate', '2.0.0:candidate', '1.0.0:enabled', '2.0.0:enabled', '1.0.0:disabled', '2.0.0:disabled', '1.0.0:enabled']
  );
});

test('the registry refuses a tool whose content does not match its id', () => {
  const registry = new DynamicToolRegistry();
  const tool = customTool();

  assert.throws(
    () => registry.propose({ ...tool, permissions: ['action:pick'] }, cleanGates()),
    /does not match its content/
  );
});
