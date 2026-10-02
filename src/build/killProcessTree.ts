import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_GRACE_MS = 1500;

export interface KillProcessTreeOptions {
  /** Wait this long after soft kill before SIGKILL / forced tree kill. */
  graceMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative PID = signal the whole process group (POSIX).
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function taskkillWindows(pid: number, force: boolean): Promise<void> {
  const args = ['/pid', String(pid), '/T'];
  if (force) {
    args.push('/F');
  }
  try {
    await execFileAsync('taskkill', args, { windowsHide: true });
  } catch {
    // Process may already have exited.
  }
}

/**
 * Soft-kill a spawned ConTeXt process tree, then hard-kill after a short grace.
 *
 * POSIX: spawn with `detached: true` so the child is a process-group leader;
 * we signal the group so `luametatex` children die with `context`.
 * Windows: `taskkill /T` then `/T /F` so the tree is torn down.
 */
export async function killProcessTree(
  child: ChildProcess,
  options: KillProcessTreeOptions = {},
): Promise<void> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pid = child.pid;
  if (pid == null || child.exitCode != null || child.signalCode != null) {
    return;
  }

  if (process.platform === 'win32') {
    await taskkillWindows(pid, false);
    const exited = await waitForExit(child, graceMs);
    if (!exited) {
      await taskkillWindows(pid, true);
      await waitForExit(child, graceMs);
    }
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');
  const exited = await waitForExit(child, graceMs);
  if (!exited) {
    signalProcessGroup(pid, 'SIGKILL');
    await waitForExit(child, graceMs);
  }
}
