import { spawn, type ChildProcess } from 'node:child_process';

export type LineLogger = (line: string) => void;

export function pipeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  label: string,
  log: LineLogger,
): void {
  if (!stream) {
    return;
  }
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
 * Probe Digestif with `--version` so we surface install/PATH/texlua errors
 * before LanguageClient initialize.
 */
export function probeDigestif(
  digestifPath: string,
  env: NodeJS.ProcessEnv,
  log: LineLogger,
  timeoutMs = 10000,
): Promise<{ ok: true; version: string } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true; version: string } | { ok: false; detail: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(digestifPath, ['--version'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      finish({
        ok: false,
        detail: `Digestif --version timed out after ${timeoutMs}ms (is texlua/lua available on PATH?).`,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, detail: `spawn failed: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = (stdout + stderr).trim();
      if (code === 0) {
        if (out) {
          log(`[digestif] ${out.split(/\r?\n/)[0]}`);
        }
        finish({ ok: true, version: out || 'ok' });
        return;
      }
      finish({
        ok: false,
        detail:
          out ||
          `Digestif --version exited code=${code}${signal ? ` signal=${signal}` : ''}. ` +
            `Often means texlua/lua is missing from PATH (Digestif wrapper needs texlua; LMTX may only ship luametatex).`,
      });
    });
  });
}

/** Spawn Digestif as an LSP stdio server; stderr is logged, stdout is LSP framing. */
export function spawnDigestifServer(options: {
  digestifPath: string;
  env: NodeJS.ProcessEnv;
  log: LineLogger;
  args?: string[];
}): Promise<ChildProcess> {
  const { digestifPath, env, log, args = ['--verbose'] } = options;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(digestifPath, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!child.pid) {
      reject(new Error(`Failed to spawn Digestif at ${digestifPath}`));
      return;
    }

    log(`[digestif] spawned pid=${child.pid}`);
    pipeLines(child.stderr, 'stderr', log);
    // Do not pipe stdout — it carries LSP JSON-RPC frames.

    child.on('error', (err) => {
      log(`[digestif] process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      log(`[digestif] process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });

    resolve(child);
  });
}
