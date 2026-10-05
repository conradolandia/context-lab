import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** True when `filePath` exists, is a regular file, and is executable by this process. */
export function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `binary` via `which` (Unix) or `where` (Windows).
 * Returns the first executable hit, or undefined.
 */
export function whichOnPath(binary: string): string | undefined {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [binary], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first && isExecutable(first) ? first : undefined;
  } catch {
    return undefined;
  }
}
