import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanCandidate } from '../guardrails/candidate-gate.js';
import type { Capability } from '../guardrails/import-allowlist.js';
import { runIsolatedChild } from '../operations/isolated-child.js';
import type { GuardResult } from '../registry/models.js';
import type { SynthesizedTool } from './synthesized-tool.js';

/**
 * The gates a synthesized tool must clear before it may be enabled.
 *
 * Static: AST, dependency allowlist, and resource/network capability. Dynamic:
 * the tool's own tests, executed in a separate process group.
 */

export interface ToolTestResult {
  readonly passed: boolean;
  readonly detail: string;
}

export interface ToolTestRunner {
  run(tool: SynthesizedTool, signal?: AbortSignal): Promise<ToolTestResult>;
}

export interface ProcessToolTestRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Runs a tool's tests in a child process that leads its own group.
 *
 * This is process isolation, not a sandbox: the tests are killable, bounded,
 * and cannot read host secrets from the environment, but nothing here confines
 * filesystem or network access. Filesystem and network confinement is the open
 * sandbox blocker.
 */
export class ProcessToolTestRunner implements ToolTestRunner {
  constructor(private readonly options: ProcessToolTestRunnerOptions = {}) {}

  async run(tool: SynthesizedTool, signal?: AbortSignal): Promise<ToolTestResult> {
    const scratch = mkdtempSync(join(tmpdir(), 'dream-rsi-tool-'));
    try {
      writeFileSync(join(scratch, 'tool.mjs'), tool.source);
      writeFileSync(join(scratch, 'tool.test.mjs'), tool.tests);

      const result = await runIsolatedChild({
        entryPath: join(scratch, 'tool.test.mjs'),
        label: `tool ${tool.name} tests`,
        timeoutMs: this.options.timeoutMs ?? 10_000,
        cwd: scratch,
        ...(this.options.maxOutputBytes !== undefined ? { maxOutputBytes: this.options.maxOutputBytes } : {}),
        ...(signal !== undefined ? { signal } : {})
      });

      if (result.exitCode !== 0) {
        return {
          passed: false,
          detail: `tests exited with code ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`
        };
      }
      const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
      let parsed: { passed?: unknown };
      try {
        parsed = JSON.parse(lastLine) as { passed?: unknown };
      } catch {
        return { passed: false, detail: 'tests produced no machine-readable verdict' };
      }
      return { passed: parsed.passed === true, detail: `tests reported passed=${String(parsed.passed)}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

export interface ToolGateOptions {
  readonly runner: ToolTestRunner;
  readonly candidateRoot?: string;
  readonly allowedPackages?: readonly string[];
  readonly allowedBuiltins?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ToolGateResult {
  readonly passed: boolean;
  readonly guardResults: readonly GuardResult[];
  readonly capabilities: readonly Capability[];
  readonly reasons: readonly string[];
}

export async function runToolGates(
  tool: SynthesizedTool,
  options: ToolGateOptions
): Promise<ToolGateResult> {
  const scan = scanCandidate({
    source: tool.source,
    fileName: `${tool.name}.mjs`,
    ...(options.candidateRoot !== undefined ? { candidateRoot: options.candidateRoot } : {}),
    ...(options.allowedPackages !== undefined ? { allowedPackages: options.allowedPackages } : {}),
    ...(options.allowedBuiltins !== undefined ? { allowedBuiltins: options.allowedBuiltins } : {})
  });

  // The tests are candidate source too, and are scanned by the same rules.
  const testScan = scanCandidate({
    source: tool.tests,
    fileName: `${tool.name}.test.mjs`,
    allowedBuiltins: ['assert'],
    ...(options.allowedPackages !== undefined ? { allowedPackages: options.allowedPackages } : {})
  });

  const guardResults: GuardResult[] = [
    {
      guard: 'astGuard',
      passed: scan.ast.passed,
      detail: scan.ast.violations.map((violation) => `${violation.rule}@${violation.line}`).join(', ') || 'clean'
    },
    {
      guard: 'dependencyAllowlist',
      passed: scan.imports.passed,
      detail: scan.imports.violations.map((violation) => violation.specifier).join(', ') || 'clean'
    },
    {
      guard: 'capabilityGuard',
      passed: scan.capabilities.length === 0,
      detail: scan.capabilities.length === 0 ? 'no resource or network capability' : scan.capabilities.join(', ')
    },
    {
      guard: 'testSourceGuards',
      passed: testScan.ast.passed && testScan.imports.passed,
      detail: [...testScan.ast.violations, ...testScan.imports.violations].map((violation) => violation.rule).join(', ') || 'clean'
    }
  ];

  // A tool whose tests cannot run has not passed them.
  try {
    const tested = await options.runner.run(tool, options.signal);
    guardResults.push({ guard: 'isolatedTests', passed: tested.passed, detail: tested.detail });
  } catch (error) {
    guardResults.push({
      guard: 'isolatedTests',
      passed: false,
      detail: `tests did not run: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  const reasons = guardResults.filter((result) => !result.passed).map((result) => `${result.guard}: ${result.detail}`);
  return { passed: reasons.length === 0, guardResults, capabilities: scan.capabilities, reasons };
}
