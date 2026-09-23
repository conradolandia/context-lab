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

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...base, ...overrides };
}

/**
 * Race a promise against a timeout. DigestiF does not speak `--version` when
 * started as an LSP server (it waits on stdin); LanguageClient initialize is
 * the real readiness check.
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
  /** Mutated as the process writes; read on exit/failure. */
  buffers: ProcessOutputBuffers;
  launch: DigestifLaunch;
}

/**
 * Spawn DigestiF as an LSP stdio server using the resolved launch.
 * Stderr is logged live and buffered; on exit the full buffer is re-logged.
 *
 * Note: DigestiF on stdio prints nothing until it receives LSP messages.
 * Running `luametatex --luaonly ~/.digestif/bin/digestif` by hand and seeing
 * silence is normal — it is waiting for initialize on stdin.
 */
export function spawnDigestifServer(options: {
  launch: DigestifLaunch;
  env: NodeJS.ProcessEnv;
  log: LineLogger;
  /** Extra DigestiF CLI flags before the LSP loop (e.g. --verbose). */
  extraArgs?: string[];
}): Promise<SpawnDigestifResult> {
  const { launch, env, log, extraArgs = ['--verbose'] } = options;
  return new Promise((resolve, reject) => {
    const childEnv = mergeEnv(env, launch.envOverrides);
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
    log(`[digestif] spawned pid=${child.pid} (stdio LSP — silence until initialize is normal)`);
    // Live stderr for DigestiF --verbose; do not pipe stdout (LSP framing).
    pipeLines(child.stderr, 'stderr', log, buffers);

    child.on('error', (err) => {
      log(`[digestif] process error: ${err.message}`);
      logProcessOutput(log, buffers);
    });

    child.on('exit', (code, signal) => {
      logProcessOutput(log, buffers, { code, signal });
      if (code && code !== 0) {
        log(
          '[digestif] hint: if stderr mentions texlua/lua/data files, see README ' +
            '(LMTX needs luametatex --luaonly, or luarocks DigestiF + context.digestifPath).',
        );
      }
    });

    resolve({ process: child, buffers, launch });
  });
}

/** Prefer DigestiF stderr over generic LanguageClient pipe errors. */
export function preferDigestifError(
  languageClientError: unknown,
  buffers?: ProcessOutputBuffers,
): string {
  const stderr = buffers?.stderr?.trim();
  const stdout = buffers?.stdout?.trim();
  const digestiMsg = stderr || stdout;
  const lcMsg =
    languageClientError instanceof Error
      ? languageClientError.message
      : String(languageClientError);
  if (digestiMsg) {
    const first = digestiMsg.split(/\r?\n/).filter(Boolean).slice(0, 4).join(' | ');
    return first;
  }
  if (/stream was destroyed|write after/i.test(lcMsg)) {
    return (
      `${lcMsg} (DigestiF exited before LSP initialize; check Output for ` +
      `[digestif] --- last stderr ---)`
    );
  }
  return lcMsg;
}
