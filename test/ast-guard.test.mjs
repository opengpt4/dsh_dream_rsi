import assert from 'node:assert/strict';
import test from 'node:test';

import { runAstGuard } from '../dist/guardrails/ast-guard.js';

test('AST guard passes ordinary policy control-flow code', () => {
  const result = runAstGuard(`
    export function pickNext(queue) {
      return queue.filter((item) => item.priority > 0).sort((a, b) => b.priority - a.priority)[0];
    }
  `);

  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test('AST guard rejects eval and new Function', () => {
  const evalResult = runAstGuard('eval("1 + 1");');
  const functionResult = runAstGuard('const f = new Function("return 1");');

  assert.equal(evalResult.passed, false);
  assert.equal(evalResult.violations[0].rule, 'forbidden-call');
  assert.equal(functionResult.passed, false);
  assert.equal(functionResult.violations[0].rule, 'forbidden-call');
});

test('AST guard rejects dynamic import() and require of forbidden modules', () => {
  const dynamicImport = runAstGuard('async function load(name) { return import(name); }');
  const requireChildProcess = runAstGuard("const cp = require('child_process');");
  const requireDynamic = runAstGuard('const mod = require(moduleName);');

  assert.equal(dynamicImport.passed, false);
  assert.equal(dynamicImport.violations[0].rule, 'dynamic-import');
  assert.equal(requireChildProcess.passed, false);
  assert.equal(requireChildProcess.violations[0].rule, 'forbidden-module');
  assert.equal(requireDynamic.passed, false);
  assert.equal(requireDynamic.violations[0].rule, 'dynamic-require');
});

test('AST guard rejects static imports of filesystem/network/process modules', () => {
  const fsImport = runAstGuard("import { readFileSync } from 'node:fs';");
  const netImport = runAstGuard("import net from 'net';");

  assert.equal(fsImport.passed, false);
  assert.equal(fsImport.violations[0].rule, 'forbidden-module');
  assert.equal(netImport.passed, false);
  assert.equal(netImport.violations[0].rule, 'forbidden-module');
});

test('AST guard rejects reading process.env and calling process.exit', () => {
  const envAccess = runAstGuard('const secret = process.env.API_KEY;');
  const exitCall = runAstGuard('process.exit(1);');

  assert.equal(envAccess.passed, false);
  assert.equal(envAccess.violations[0].rule, 'forbidden-member-access');
  assert.equal(exitCall.passed, false);
  assert.equal(exitCall.violations[0].rule, 'forbidden-member-access');
});

test('AST guard reports line and column for a violation', () => {
  const result = runAstGuard('const a = 1;\nconst b = eval("2");');

  assert.equal(result.passed, false);
  assert.equal(result.violations[0].line, 2);
  assert.ok(result.violations[0].column > 0);
});
