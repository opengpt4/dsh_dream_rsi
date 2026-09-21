import { spawn } from 'node:child_process';

/**
 * Run one child process under the isolation properties this project relies on.
 *
 * The child leads its own process group, so a deadline, a cancellation, or an
 * output overflow kills everything it spawned rather than just the direct
 * child. Output is bounded on both streams and the environment defaults to
 * `PATH` only, so a child cannot read the host's secrets.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export interface RunIsolatedChildOptions {
  readonly entryPath: string;
  /** Names the child in timeout and overflow messages. */
  readonly label: string;
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
}

export interface IsolatedChildResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runIsolatedChild(options: RunIsolatedChildOptions): Promise<IsolatedChildResult> {
  const { label, timeoutMs } = options;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('timeoutMs must be positive'));
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new Error('maxOutputBytes must be a positive integer'));
  }
  if (options.signal?.aborted === true) return Promise.reject(new Error(`${label} cancelled before start`));

  const child = spawn(options.execPath ?? process.execPath, [options.entryPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
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

    const timer = setTimeout(() => stop(`${label} timed out after ${timeoutMs}ms`), timeoutMs);
    const onAbort = (): void => stop(`${label} cancelled`);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        stop(`${label} exceeded maxOutputBytes (${maxOutputBytes})`);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        stop(`${label} stderr exceeded maxOutputBytes (${maxOutputBytes})`);
      }
    });

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => resolve({ exitCode: code, stdout, stderr })));

    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin);
  });
}
