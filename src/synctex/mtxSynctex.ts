import { spawn } from 'node:child_process';
import type { Toolchain } from '../toolchain/discover';

export interface ForwardSyncResult {
  page: number;
  llx: number;
  lly: number;
  urx: number;
  ury: number;
}

export interface BackwardSyncResult {
  filename: string;
  linenumber: number;
  tolerance: number;
}

export class SynctexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynctexError';
  }
}

/** Parse mtxrun --script synctex --find [--direct] output. */
export function parseFindOutput(text: string): ForwardSyncResult | undefined {
  // page=1 llx=72.0 lly=680.5 urx=300.2 ury=700.1
  const re =
    /page\s*=\s*(\d+)\s+llx\s*=\s*([-\d.]+)\s+lly\s*=\s*([-\d.]+)\s+urx\s*=\s*([-\d.]+)\s+ury\s*=\s*([-\d.]+)/i;
  const m = text.match(re);
  if (!m) {
    return undefined;
  }
  return {
    page: Number(m[1]),
    llx: Number(m[2]),
    lly: Number(m[3]),
    urx: Number(m[4]),
    ury: Number(m[5]),
  };
}

/** Parse mtxrun --script synctex --report [--direct] output. */
export function parseReportOutput(text: string): BackwardSyncResult | undefined {
  // filename=foo.tex linenumber=42 tolerance=0
  const re =
    /filename\s*=\s*(\S+)\s+linenumber\s*=\s*(\d+)\s+tolerance\s*=\s*(\d+)/i;
  const m = text.match(re);
  if (!m) {
    return undefined;
  }
  return {
    filename: m[1],
    linenumber: Number(m[2]),
    tolerance: Number(m[3]),
  };
}

function runMtx(
  toolchain: Toolchain,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(toolchain.mtxrunPath, args, {
      cwd,
      env: process.env,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/**
 * Forward SyncTeX: source file+line → PDF page and box, using a frozen synctex snapshot.
 */
export async function forwardSync(
  toolchain: Toolchain,
  synctexSnapshot: string,
  sourceFile: string,
  line: number,
  cwd?: string,
): Promise<ForwardSyncResult> {
  const args = [
    '--script',
    'synctex',
    '--find',
    '--direct',
    `--file=${sourceFile}`,
    `--line=${line}`,
    synctexSnapshot,
  ];
  const { stdout, stderr, exitCode } = await runMtx(toolchain, args, cwd);
  const combined = `${stdout}\n${stderr}`;
  const parsed = parseFindOutput(combined);
  if (!parsed) {
    throw new SynctexError(
      `Forward SyncTeX produced no match (exit ${exitCode}): ${combined.trim() || '(empty output)'}`,
    );
  }
  return parsed;
}

/**
 * Backward SyncTeX: PDF page+coords → source file+line, using a frozen synctex snapshot.
 */
export async function backwardSync(
  toolchain: Toolchain,
  synctexSnapshot: string,
  page: number,
  x: number,
  y: number,
  cwd?: string,
  tolerance = 10,
): Promise<BackwardSyncResult> {
  const args = [
    '--script',
    'synctex',
    '--report',
    '--direct',
    `--page=${page}`,
    `--x=${x}`,
    `--y=${y}`,
    `--tolerance=${tolerance}`,
    synctexSnapshot,
  ];
  const { stdout, stderr, exitCode } = await runMtx(toolchain, args, cwd);
  const combined = `${stdout}\n${stderr}`;
  const parsed = parseReportOutput(combined);
  if (!parsed) {
    throw new SynctexError(
      `Backward SyncTeX produced no match (exit ${exitCode}): ${combined.trim() || '(empty output)'}`,
    );
  }
  return parsed;
}
