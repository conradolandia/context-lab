import { spawn } from 'node:child_process';
import * as path from 'node:path';
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

export interface SynctexRunSpec {
  args: string[];
  cwd: string;
  synctexPath: string;
}

/**
 * Prefer a path relative to the job directory so --file= matches Input: entries
 * embedded in ConTeXt synctex logs (often project-relative).
 */
export function synctexSourceArg(sourceFile: string, jobDir: string): string {
  const abs = path.resolve(sourceFile);
  const root = path.resolve(jobDir);
  const rel = path.relative(root, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    // ConTeXt Input paths typically use forward slashes
    return rel.split(path.sep).join('/');
  }
  return abs;
}

/** Build argv for forward SyncTeX (`--find --direct`). */
export function buildFindArgs(
  synctexPath: string,
  sourceFile: string,
  line: number,
  jobDir: string,
): SynctexRunSpec {
  const fileArg = synctexSourceArg(sourceFile, jobDir);
  const absSynctex = path.resolve(synctexPath);
  return {
    cwd: path.resolve(jobDir),
    synctexPath: absSynctex,
    args: [
      '--script',
      'synctex',
      '--find',
      '--direct',
      `--file=${fileArg}`,
      `--line=${line}`,
      absSynctex,
    ],
  };
}

/**
 * Build argv for backward SyncTeX.
 *
 * Use `--goto --direct` without `--editor`. Plain `--report` hardcodes editor
 * "console", which calls editfile on the matched .tex and yields
 * "invalid synctex log file '<tex path>'" or empty stdout instead of
 * filename=/linenumber= output.
 */
export function buildReportArgs(
  synctexPath: string,
  page: number,
  x: number,
  y: number,
  jobDir: string,
  tolerance = 50,
): SynctexRunSpec {
  const absSynctex = path.resolve(synctexPath);
  // Round to avoid float noise; mtxrun expects PDF user-space points (bp).
  const xr = Number(x.toFixed(3));
  const yr = Number(y.toFixed(3));
  return {
    cwd: path.resolve(jobDir),
    synctexPath: absSynctex,
    args: [
      '--script',
      'synctex',
      '--goto',
      '--direct',
      `--page=${page}`,
      `--x=${xr}`,
      `--y=${yr}`,
      `--tolerance=${tolerance}`,
      absSynctex,
    ],
  };
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

/** Parse mtxrun --script synctex --goto/--report [--direct] output. */
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

/** True when mtxrun reported a ConTeXt synctex open/parse failure. */
export function isInvalidSynctexLogMessage(text: string): boolean {
  return /invalid synctex log file/i.test(text);
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

export interface SynctexInvokeResult<T> {
  result: T;
  argv: string[];
  cwd: string;
  stdout: string;
  stderr: string;
}

/**
 * Forward SyncTeX: source file+line → PDF page and box.
 * Always runs with cwd = job/project directory.
 */
export async function forwardSync(
  toolchain: Toolchain,
  synctexPath: string,
  sourceFile: string,
  line: number,
  jobDir: string,
): Promise<SynctexInvokeResult<ForwardSyncResult>> {
  const spec = buildFindArgs(synctexPath, sourceFile, line, jobDir);
  const { stdout, stderr, exitCode } = await runMtx(toolchain, spec.args, spec.cwd);
  const combined = `${stdout}\n${stderr}`;
  const parsed = parseFindOutput(combined);
  if (!parsed) {
    throw new SynctexError(
      `Forward SyncTeX produced no match (exit ${exitCode}) cwd=${spec.cwd} argv=${JSON.stringify(spec.args)}: ${combined.trim() || '(empty output)'}`,
    );
  }
  return { result: parsed, argv: spec.args, cwd: spec.cwd, stdout, stderr };
}

/**
 * Backward SyncTeX: PDF page+coords → source file+line.
 * Always runs with cwd = job/project directory; uses --goto --direct (not --report).
 */
export async function backwardSync(
  toolchain: Toolchain,
  synctexPath: string,
  page: number,
  x: number,
  y: number,
  jobDir: string,
  tolerance = 50,
): Promise<SynctexInvokeResult<BackwardSyncResult>> {
  const spec = buildReportArgs(synctexPath, page, x, y, jobDir, tolerance);
  const { stdout, stderr, exitCode } = await runMtx(toolchain, spec.args, spec.cwd);
  const combined = `${stdout}\n${stderr}`;
  const parsed = parseReportOutput(combined);
  if (!parsed) {
    const hint = isInvalidSynctexLogMessage(combined)
      ? ' (mtx-synctex rejected the log path — check cwd and synctex argv)'
      : '';
    throw new SynctexError(
      `Backward SyncTeX produced no match (exit ${exitCode}) cwd=${spec.cwd} argv=${JSON.stringify(spec.args)}${hint}: ${combined.trim() || '(empty output)'}`,
    );
  }
  return { result: parsed, argv: spec.args, cwd: spec.cwd, stdout, stderr };
}
