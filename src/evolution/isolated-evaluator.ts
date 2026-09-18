import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { EvaluationInput, EvaluationResult, EvaluatorConfig } from './evaluator.js';

export interface IsolatedEvaluatorOptions {
  readonly timeoutMs?: number;
}

export function evaluateReplayIsolated(
  input: EvaluationInput,
  config?: EvaluatorConfig,
  options: IsolatedEvaluatorOptions = {}
): Promise<EvaluationResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('timeoutMs must be positive'));

  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./evaluator-worker.js', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      worker.kill('SIGKILL');
      finish(() => reject(new Error(`isolated evaluator timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => { output += chunk; });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('close', (code) => {
      finish(() => {
        if (code !== 0) return reject(new Error(`isolated evaluator exited with code ${code}`));
        try {
          const response = JSON.parse(output) as { result?: EvaluationResult; error?: string };
          if (response.error) return reject(new Error(response.error));
          if (!response.result) return reject(new Error('isolated evaluator returned no result'));
          resolve(response.result);
        } catch (error) {
          reject(error);
        }
      });
    });
    worker.stdin.end(JSON.stringify({ input, config }) + '\n');
  });
}