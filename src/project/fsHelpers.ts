import * as fs from 'node:fs';

/** True when `p` exists and is a regular file (not a directory). */
export function existsRegularFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read a UTF-8 file; return `undefined` on any I/O error. */
export function readUtf8File(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}
