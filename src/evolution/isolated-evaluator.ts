import { fileURLToPath } from 'node:url';

import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OLD_SPACE_SIZE_MB, runIsolatedChild, type ChildConfinement, type SandboxCommand } from '../operations/isolated-child.js';
import type { EvaluationInput, EvaluationResult, EvaluatorConfig } from './evaluator.js';

export { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OLD_SPACE_SIZE_MB };

const RESULT_FIELDS = ['quality', 'cost', 'parallelEfficiency', 'missRate', 'score'] as const;

export interface IsolatedEvaluatorOptions {
  readonly timeoutMs?: number;
  /** Kill the child once captured stdout exceeds this. */
  readonly maxOutputBytes?: number;
  /**
   * V8 heap ceiling for the child, in MiB. Defaults to
   * {@link DEFAULT_MAX_OLD_SPACE_SIZE_MB}, so a candidate that allocates without
   * bound is stopped by the child rather than by the host running out of memory.
   */
  readonly maxOldSpaceSizeMb?: number;
  /** Cancels the run and terminates the child's process group. */
  readonly signal?: AbortSignal;
  /**
   * Environment for the child. Defaults to `PATH` only: a candidate must not be
   * able to read host secrets, and inheriting `process.env` would hand it every
   * API key the parent holds.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Worker entry point. Defaults to the bundled evaluator worker. */
  readonly workerPath?: string;
  /** Runtime confinement. Defaults to on; `false` disables it. */
  readonly confinement?: ChildConfinement | false;
  /** A runtime the host provides to confine the child, such as a container or OS sandbox. */
  readonly sandbox?: SandboxCommand;
}

/**
 * Runs the evaluator in a child process.
 *
 * The child leads its own process group, so a deadline, a cancellation, or an
 * output overflow terminates anything it spawned rather than just the direct
 * child. Killing only the direct child would leave grandchildren running with
 * the host's privileges.
 */
export async function evaluateReplayIsolated(
  input: EvaluationInput,
  config?: EvaluatorConfig,
  options: IsolatedEvaluatorOptions = {}
): Promise<EvaluationResult> {
  const result = await runIsolatedChild({
    entryPath: options.workerPath ?? fileURLToPath(new URL('./evaluator-worker.js', import.meta.url)),
    label: 'isolated evaluator',
    timeoutMs: options.timeoutMs ?? 5_000,
    stdin: `${JSON.stringify({ input, config })}\n`,
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.maxOldSpaceSizeMb !== undefined ? { maxOldSpaceSizeMb: options.maxOldSpaceSizeMb } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.confinement !== undefined ? { confinement: options.confinement } : {}),
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {})
  });

  if (result.exitCode !== 0) {
    throw new Error(`isolated evaluator exited with code ${result.exitCode}: ${result.stderr.trim().slice(0, 512)}`);
  }
  const response = JSON.parse(result.stdout) as { result?: unknown; error?: string };
  if (response.error) throw new Error(response.error);
  return parseEvaluationResult(response.result);
}

/**
 * Rebuild the result field by field from untrusted JSON.
 *
 * Validating and copying rather than casting means a crafted response cannot
 * smuggle extra properties or a prototype into the caller's evaluator output.
 */
function parseEvaluationResult(value: unknown): EvaluationResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('isolated evaluator returned a non-object result');
  }
  const record = value as Record<string, unknown>;
  for (const field of RESULT_FIELDS) {
    const candidate = record[field];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new Error(`isolated evaluator returned an invalid ${field}`);
    }
  }
  return {
    quality: record.quality as number,
    cost: record.cost as number,
    parallelEfficiency: record.parallelEfficiency as number,
    missRate: record.missRate as number,
    score: record.score as number
  };
}
