import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Run one child process under the isolation properties this project relies on.
 *
 * The child leads its own process group, so a deadline, a cancellation, or an
 * output overflow kills everything it spawned rather than just the direct
 * child. Output is bounded on both streams and the environment defaults to
 * `PATH` only, so a child cannot read the host's secrets.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * V8 heap ceiling for a child, in MiB.
 *
 * A resource bound, not a permission-model grant, so it applies whether or not
 * confinement is on: a child that cannot use `--experimental-permission` can
 * still be stopped from allocating the host to death. V8 aborts the child when
 * the ceiling is reached, which reaches the caller as a non-zero exit.
 */
export const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 512;

/**
 * Runtime confinement for the child, via Node's permission model.
 *
 * On by default: the child may read its own directory and nothing else, and may
 * not write, spawn, or start a worker thread. This is defense in depth, not the
 * OS/container sandbox — Node documents the permission model as not a security
 * boundary against hostile native code, and it does not restrict network access
 * or CPU time.
 */
export interface ChildConfinement {
  /** Directories the child may read. Defaults to the entry point's directory. */
  readonly allowRead?: readonly string[];
  /** Never granted by default. */
  readonly allowWrite?: readonly string[];
  /**
   * Grants `child_process`. Off by default, which is what bounds process count.
   * Worker threads stay denied: a second isolate is a second heap, so admitting
   * one would multiply the child's memory ceiling, and the two grants are
   * deliberately not the same switch.
   */
  readonly allowChildProcess?: boolean;
}

/**
 * A command the host supplies to confine the child.
 *
 * The plugin bundles no runtime: a container, an OS sandbox, or a wrapper script
 * is the host's to name, and its own flags are where CPU, memory, process and
 * network limits are expressed. The command line is built as
 * `[...args, node, ...nodeArgs, entryPath]`, with no shell in between, so a
 * template cannot turn into a command injection.
 */
export interface SandboxCommand {
  readonly command: string;
  /** Everything before the child's own command line. */
  readonly args: readonly string[];
}

export interface RunIsolatedChildOptions {
  readonly entryPath: string;
  /** Names the child in timeout and overflow messages. */
  readonly label: string;
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly maxOutputBytes?: number;
  /** V8 heap ceiling in MiB. Defaults to {@link DEFAULT_MAX_OLD_SPACE_SIZE_MB}. */
  readonly maxOldSpaceSizeMb?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  /** Confinement the host provides. Absent runs the child directly, as before. */
  readonly sandbox?: SandboxCommand;
  readonly execPath?: string;
  /** `false` disables confinement entirely. A host that cannot use the flag must say so. */
  readonly confinement?: ChildConfinement | false;
}

export interface IsolatedChildResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Resource flags for a child, applied whether or not confinement is on.
 *
 * The heap ceiling is a V8 flag rather than a permission-model grant, so a host
 * that has to disable confinement still gets a memory bound.
 */
function resourceArgs(options: RunIsolatedChildOptions): string[] {
  const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_SIZE_MB;
  return [`--max-old-space-size=${maxOldSpaceSizeMb}`];
}

/**
 * Build the permission-model flags for a child.
 *
 * The entry point's own directory is readable because the child has to load
 * itself; granting that rather than `--allow-fs-read=*` is the difference
 * between running a file and reading the disk.
 */
function permissionArgs(options: RunIsolatedChildOptions, entryPath: string): string[] {
  if (options.confinement === false) return [];
  const confinement = options.confinement ?? {};
  const readPaths = confinement.allowRead ?? [join(dirname(entryPath), '*')];

  const args = ['--experimental-permission'];
  for (const path of readPaths) args.push(`--allow-fs-read=${resolveGrant(path)}`);
  for (const path of confinement.allowWrite ?? []) args.push(`--allow-fs-write=${resolveGrant(path)}`);
  if (confinement.allowChildProcess === true) args.push('--allow-child-process');
  return args;
}

/**
 * Resolve a granted path so it matches what the child computes for itself.
 *
 * An explicit grant has the same symlink problem as the default one, so every
 * path goes through here rather than only the derived one.
 */
function resolveGrant(path: string): string {
  const isGlob = path.endsWith('/*');
  const base = isGlob ? path.slice(0, -2) : path;
  try {
    return `${realpathSync(base)}${isGlob ? '/*' : ''}`;
  } catch {
    return path;
  }
}

function resolveEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    // Let the spawn report the missing file rather than failing here.
    return entryPath;
  }
}

export function runIsolatedChild(options: RunIsolatedChildOptions): Promise<IsolatedChildResult> {
  const { label, timeoutMs } = options;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('timeoutMs must be positive'));
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new Error('maxOutputBytes must be a positive integer'));
  }
  const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_SIZE_MB;
  if (!Number.isInteger(maxOldSpaceSizeMb) || maxOldSpaceSizeMb <= 0) {
    return Promise.reject(new Error('maxOldSpaceSizeMb must be a positive integer'));
  }
  if (options.signal?.aborted === true) return Promise.reject(new Error(`${label} cancelled before start`));

  // Resolve the entry point before granting it. On macOS `tmpdir()` is a
  // symlink, so a granted `/var/...` path never matches the `/private/var/...`
  // path the child computes when it resolves itself, and the child dies before
  // it can run anything.
  const entryPath = resolveEntryPath(options.entryPath);
  const nodePath = options.execPath ?? process.execPath;
  const nodeArgs = [...resourceArgs(options), ...permissionArgs(options, entryPath), entryPath];
  // The sandbox, when there is one, wraps the node command rather than replacing
  // it: the child still runs under the resource and permission arguments.
  const sandbox = options.sandbox;
  if (sandbox !== undefined && sandbox.command.trim().length === 0) {
    return Promise.reject(new Error(`${label} sandbox command must not be empty`));
  }
  const child = spawn(
    sandbox?.command ?? nodePath,
    sandbox === undefined ? nodeArgs : [...sandbox.args, nodePath, ...nodeArgs],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin' }
    }
  );

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
