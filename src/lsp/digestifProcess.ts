import { spawn, type ChildProcess } from 'node:child_process';
import type { DigestifLaunch } from './digestifLaunch';

export type LineLogger = (line: string) => void;

export interface ProcessOutputBuffers {
  stdout: string;
  stderr: string;
}

/** Default timeout for LanguageClient.start() / LSP initialize. */
export const DIGESTIF_START_TIMEOUT_MS = 30_000;

/** Log buffered DigestiF output; call on exit or failure. */
export function logProcessOutput(
  log: LineLogger,
  buffers: ProcessOutputBuffers,
  opts?: { code?: number | null; signal?: NodeJS.Signals | null },
): string {
  const stderr = buffers.stderr.trim();
  const stdout = buffers.stdout.trim();
  if (opts?.code != null || opts?.signal) {
    log(
      `[digestif] process exited code=${opts.code ?? 'null'} signal=${opts.signal ?? 'null'}`,
    );
  }
  if (stderr) {
    log('[digestif] --- last stderr ---');
    for (const line of stderr.split(/\r?\n/)) {
      log(`[digestif stderr] ${line}`);
    }
    log('[digestif] --- end stderr ---');
  } else if (opts?.code != null || opts?.signal) {
    log('[digestif] (no stderr captured)');
  }
  if (stdout && (opts?.code != null || opts?.signal)) {
    const preview = stdout.length > 2000 ? `${stdout.slice(0, 2000)}…` : stdout;
    log('[digestif] --- last stdout ---');
    for (const line of preview.split(/\r?\n/)) {
      log(`[digestif stdout] ${line}`);
    }
    log('[digestif] --- end stdout ---');
  }
  return stderr || stdout;
}

export function pipeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  label: string,
  log: LineLogger,
  buffers?: ProcessOutputBuffers,
): void {
  if (!stream) {
    return;
  }
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (buffers) {
      if (label === 'stderr') {
        buffers.stderr += text;
      } else if (label === 'stdout') {
        buffers.stdout += text;
      }
    }
    buf += text;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        log(`[digestif ${label}] ${line}`);
      }
    }
  });
  stream.on('end', () => {
    const rest = buf.replace(/\r$/, '').trim();
    if (rest) {
      log(`[digestif ${label}] ${rest}`);
    }
  });
}

/**
 * Race a promise against a timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface SpawnDigestifResult {
  process: ChildProcess;
  buffers: ProcessOutputBuffers;
  launch: DigestifLaunch;
}

/**
 * Spawn DigestiF as an LSP stdio server.
 * `env` must already be the clean DigestiF env (user env + DIGESTIF_* only).
 * Stderr is log-only and must never be treated as an initialization failure.
 */
export function spawnDigestifServer(options: {
  launch: DigestifLaunch;
  env: NodeJS.ProcessEnv;
  log: LineLogger;
  extraArgs?: string[];
}): Promise<SpawnDigestifResult> {
  const { launch, env, log, extraArgs = ['--verbose'] } = options;
  return new Promise((resolve, reject) => {
    const childEnv = { ...env, ...launch.envOverrides };
    const args = [...launch.args, ...extraArgs];
    log(`[digestif] spawn: ${launch.command} ${args.join(' ')}`);
    log(`[digestif] launch method=${launch.method} — ${launch.detail}`);

    let child: ChildProcess;
    try {
      child = spawn(launch.command, args, {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!child.pid) {
      reject(new Error(`Failed to spawn DigestiF: ${launch.command}`));
      return;
    }

    const buffers: ProcessOutputBuffers = { stdout: '', stderr: '' };
    log(`[digestif] spawned pid=${child.pid}`);
    // Stderr is diagnostic only; do not treat it as LSP failure.
    pipeLines(child.stderr, 'stderr', log, buffers);

    child.on('error', (err) => {
      log(`[digestif] process error: ${err.message}`);
      logProcessOutput(log, buffers);
    });

    child.on('exit', (code, signal) => {
      logProcessOutput(log, buffers, { code, signal });
    });

    resolve({ process: child, buffers, launch });
  });
}

/**
 * Format a LanguageClient / start error for logs.
 * DigestiF stderr is intentionally ignored here — it is log-only.
 */
export function preferDigestifError(
  languageClientError: unknown,
  _buffers?: ProcessOutputBuffers,
): string {
  void _buffers;
  if (languageClientError instanceof Error) {
    return languageClientError.message;
  }
  return String(languageClientError);
}
