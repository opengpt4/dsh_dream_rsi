import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { EvaluationInput, EvaluationResult, EvaluatorConfig } from './evaluator.js';

/** Default ceiling on captured child output, in bytes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

const RESULT_FIELDS = ['quality', 'cost', 'parallelEfficiency', 'missRate', 'score'] as const;

export interface IsolatedEvaluatorOptions {
  readonly timeoutMs?: number;
  /** Kill the child once captured stdout exceeds this. */
  readonly maxOutputBytes?: number;
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
}

/**
 * Runs the evaluator in a child process, one process group per run.
 *
 * The child is spawned detached so it leads its own group, which is what makes
 * terminating it also terminate anything it spawned. Killing only the direct
 * child would leave grandchildren running with the host's privileges.
 */
export function evaluateReplayIsolated(
  input: EvaluationInput,
  config?: EvaluatorConfig,
  options: IsolatedEvaluatorOptions = {}
): Promise<EvaluationResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('timeoutMs must be positive'));
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new Error('maxOutputBytes must be a positive integer'));
  }
  if (options.signal?.aborted === true) return Promise.reject(new Error('isolated evaluator cancelled before start'));

  const workerPath = options.workerPath ?? fileURLToPath(new URL('./evaluator-worker.js', import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: options.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the whole group, including grandchildren.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone, or never became a leader.
        try {
          child.kill('SIGKILL');
        } catch {
          // Nothing left to kill.
        }
      }
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };

    const stop = (reason: string): void => {
      killGroup();
      finish(() => reject(new Error(reason)));
    };

    const timer = setTimeout(() => stop(`isolated evaluator timed out after ${timeoutMs}ms`), timeoutMs);
    const onAbort = (): void => stop('isolated evaluator cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        stop(`isolated evaluator exceeded maxOutputBytes (${maxOutputBytes})`);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        stop(`isolated evaluator stderr exceeded maxOutputBytes (${maxOutputBytes})`);
      }
    });

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => {
        try {
          if (code !== 0) {
            throw new Error(`isolated evaluator exited with code ${code}: ${stderr.trim().slice(0, 512)}`);
          }
          const response = JSON.parse(stdout) as { result?: unknown; error?: string };
          if (response.error) throw new Error(response.error);
          resolve(parseEvaluationResult(response.result));
        } catch (error) {
          reject(error);
        }
      });
    });

    child.stdin.end(JSON.stringify({ input, config }) + '\n');
  });
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
