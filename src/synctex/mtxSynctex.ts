import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { Toolchain } from '../toolchain/discover';
import {
  boxArea,
  boxVerticalCenter,
  COARSE_FLOAT_LINE_USER_MESSAGE,
  estimatePageHeightFromBoxes,
  estimatePageWidthFromBoxes,
  FORWARD_EDGE_BAND_FRAC,
  FORWARD_MAX_BOX_PAGE_FRAC,
  isOversizedForwardBox,
  isSuspiciousFileStartHit,
  nearestSynctexBox,
  pickForwardSameLineBox,
  readSynctexPageBoxes,
  scaleSynctexBox,
  synctexFilenamesMatch,
  synctexUnitScaleToPt,
  type SynctexBox,
} from './synctexBoxes';

export {
  boxArea,
  boxVerticalCenter,
  COARSE_FLOAT_LINE_USER_MESSAGE,
  distanceToBox,
  estimatePageHeightFromBoxes,
  FORWARD_EDGE_BAND_FRAC,
  FORWARD_MAX_BOX_PAGE_FRAC,
  isOversizedForwardBox,
  isSuspiciousFileStartHit,
  nearestSynctexBox,
  parseSynctexPageBoxes,
  pickForwardSameLineBox,
  readSynctexPageBoxes,
  scaleSynctexBox,
  synctexFilenamesMatch,
  synctexUnitScaleToPt,
  SYNCTEX_SP_PER_PT,
  SUSPICIOUS_TOP_LINE_MAX,
  MID_PAGE_MTX_Y_MIN,
} from './synctexBoxes';
export type { SynctexBox } from './synctexBoxes';

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
  /** True when we replaced a suspicious file-start hit with a nearer box. */
  refined?: boolean;
  /** True when the hit still looks like a float/caption coarse tag (line ≤ 1 mid-page). */
  coarseFloatLine?: boolean;
}

export type SynctexErrorKind = 'empty' | 'invalid' | 'other';

export class SynctexError extends Error {
  readonly kind: SynctexErrorKind;

  constructor(message: string, kind: SynctexErrorKind = 'other') {
    super(message);
    this.name = 'SynctexError';
    this.kind = kind;
  }
}

/** Default `--tolerance` for `--report` (mtx default is 10). */
export const DEFAULT_REPORT_TOLERANCE = 50;

/**
 * Second-pass snap tolerance when the first `--report` returns empty.
 * mtx-synctex already walks offsets within `--tolerance`; a larger value
 * only widens that search — it does not invent a line for image-only hits.
 */
export const SNAP_REPORT_TOLERANCE = 150;

/**
 * Short toast when mtx `--report` exits with empty stdout (no box within
 * tolerance). Common for figure/image regions that have no SyncTeX records.
 */
export const EMPTY_BACKWARD_USER_MESSAGE =
  'No SyncTeX data at this point — common for images and pure graphics. Click near text to jump to source.';

/** True when mtx produced no parseable hit and no invalid-log complaint. */
export function isEmptyReportOutput(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) {
    return true;
  }
  if (isInvalidSynctexLogMessage(combined)) {
    return false;
  }
  return parseReportOutput(combined) === undefined;
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
    return rel.split(path.sep).join('/');
  }
  return abs;
}

/** Strip optional single/double quotes from mtxrun --direct field values. */
export function unquoteSynctexValue(raw: string): string {
  const s = raw.trim();
  if (
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2) ||
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
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
 * Build argv for backward SyncTeX per mtx-synctex --help:
 * `--report --direct --console --page=.. --x=.. --y=.. [--tolerance=..] <synctexfile>`
 *
 * Do not use `--goto` with `--direct`, and do not pass `--editor`
 * (the extension opens the file itself).
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
  const xr = Number(x.toFixed(3));
  const yr = Number(y.toFixed(3));
  return {
    cwd: path.resolve(jobDir),
    synctexPath: absSynctex,
    args: [
      '--script',
      'synctex',
      '--report',
      '--direct',
      '--console',
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
  // page=1 llx=72.0 …  or page='1' llx='72.0' …
  const re =
    /page\s*=\s*['"]?([-\d.]+)['"]?\s+llx\s*=\s*['"]?([-\d.]+)['"]?\s+lly\s*=\s*['"]?([-\d.]+)['"]?\s+urx\s*=\s*['"]?([-\d.]+)['"]?\s+ury\s*=\s*['"]?([-\d.]+)['"]?/i;
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

/**
 * Parse mtxrun --script synctex --report --direct [--console] output.
 *
 * Forms accepted:
 * 1. Keyed: filename='…' linenumber='2' tolerance=0  (or bare values)
 * 2. Console (--direct --console): "rel/or/abs/path.tex" <line> <tolerance>
 *    e.g. "include/contenido/00-1-dedicatoria.tex" 2 11
 */
export function parseReportOutput(text: string): BackwardSyncResult | undefined {
  const keyed =
    /filename\s*=\s*(\S+)\s+linenumber\s*=\s*['"]?(\d+)['"]?\s+tolerance\s*=\s*['"]?(\d+)['"]?/i;
  const keyedMatch = text.match(keyed);
  if (keyedMatch) {
    return {
      filename: unquoteSynctexValue(keyedMatch[1]),
      linenumber: Number(keyedMatch[2]),
      tolerance: Number(keyedMatch[3]),
    };
  }

  // Prefer a quoted path token; fall back to a bare *.tex path.
  const consoleQuoted =
    /(?:^|[\s|])(["'])([^"'\n]+)\1\s+(\d+)\s+(\d+)\s*(?:$|[\r\n])/m;
  const q = text.match(consoleQuoted);
  if (q) {
    return {
      filename: q[2],
      linenumber: Number(q[3]),
      tolerance: Number(q[4]),
    };
  }

  const consoleBare =
    /(?:^|[\s|])(\S+\.(?:tex|ctx|mkiv|mkxl))\s+(\d+)\s+(\d+)\s*(?:$|[\r\n])/im;
  const b = text.match(consoleBare);
  if (b) {
    return {
      filename: b[1],
      linenumber: Number(b[2]),
      tolerance: Number(b[3]),
    };
  }

  return undefined;
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
  /** Optional note when we refined or flagged a coarse float/caption hit. */
  note?: string;
}

/**
 * Convert a synctex content box (top-down pt after unit scale) to an mtx
 * `--find`-style PDF bottom-up box for the viewer.
 */
function synctexBoxToFindResult(
  box: SynctexBox,
  page: number,
  pageHeightPt: number,
): ForwardSyncResult {
  const topFromTop = box.y - box.d;
  const bottomFromTop = box.y + box.h;
  return {
    page,
    llx: box.x,
    urx: box.x + box.w,
    // PDF: larger y is higher on the page
    lly: pageHeightPt - bottomFromTop,
    ury: pageHeightPt - topFromTop,
  };
}

function hitVerticalCenter(hit: ForwardSyncResult): number {
  return (Math.min(hit.lly, hit.ury) + Math.max(hit.lly, hit.ury)) / 2;
}

function hitArea(hit: ForwardSyncResult): number {
  return Math.abs(hit.urx - hit.llx) * Math.abs(hit.ury - hit.lly);
}

/** Compact same-line box dump for ConTeXt debug (forward SyncTeX, pt space). */
export interface ForwardSameLineBoxDiag {
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
  cy: number;
  area: number;
  inEdge: boolean;
  oversized: boolean;
}

/** Diagnostic detail for one forward refine pass (logged when debugOutput). */
export interface ForwardRefineDiag {
  raw: ForwardSyncResult;
  chosen: ForwardSyncResult;
  pageHeight: number;
  pageWidth: number;
  band: number;
  hitCy: number;
  hitInEdge: boolean;
  sameLineCount: number;
  sameLineBoxes: ForwardSameLineBoxDiag[];
  /** 1 (pt), 65536 (sp→pt), or null when refine skipped for units. */
  unitScale: number | null;
  action:
    | 'keep-raw'
    | 'no-boxes'
    | 'no-same-line'
    | 'oversized-skip'
    | 'units-skip'
    | 'refined';
}

function summarizeSameLineBoxes(
  boxes: SynctexBox[],
  sourceFile: string,
  line: number,
  pageHeight: number,
  pageWidth: number,
): ForwardSameLineBoxDiag[] {
  const band = Math.max(24, pageHeight * FORWARD_EDGE_BAND_FRAC);
  return boxes
    .filter(
      (b) =>
        b.linenumber === line && synctexFilenamesMatch(b.filename, sourceFile),
    )
    .map((b) => {
      const cy = boxVerticalCenter(b);
      return {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        d: b.d,
        cy,
        area: boxArea(b),
        inEdge: cy < band || cy > pageHeight - band,
        oversized: isOversizedForwardBox(b, pageHeight, pageWidth),
      };
    });
}

/**
 * When mtx `--find` lands in a thin header/footer band, replace with a
 * same-line box outside that band closest to the mtx hit (not page middle).
 * Never replace with a near-full-page box (solid SyncTeX overlay in the viewer).
 *
 * Same-line candidates come from parsing the `.synctex` file (not mtx API).
 * Raw records are often TeX sp; convert to `--find` points before compare.
 * Synctex y is top-down; `--find` / viewer use PDF bottom-up — flip on output.
 */
export function refineForwardHit(
  synctexPath: string,
  sourceFile: string,
  line: number,
  hit: ForwardSyncResult,
): { result: ForwardSyncResult; note?: string; diag: ForwardRefineDiag } {
  const boxesRaw = readSynctexPageBoxes(synctexPath, hit.page);
  const emptyDiag = (
    action: ForwardRefineDiag['action'],
    unitScale: number | null = null,
  ): ForwardRefineDiag => ({
    raw: hit,
    chosen: hit,
    pageHeight: 0,
    pageWidth: 0,
    band: 0,
    hitCy: hitVerticalCenter(hit),
    hitInEdge: false,
    sameLineCount: 0,
    sameLineBoxes: [],
    unitScale,
    action,
  });

  if (boxesRaw.length === 0) {
    return { result: hit, diag: emptyDiag('no-boxes') };
  }

  const unitScale = synctexUnitScaleToPt(boxesRaw, hit);
  if (unitScale == null) {
    return {
      result: hit,
      note: 'forward edge-band refine skipped (synctex box units unknown)',
      diag: emptyDiag('units-skip'),
    };
  }

  const boxes = boxesRaw.map((b) => scaleSynctexBox(b, unitScale));
  const pageHeight =
    boxes.length > 0 ? estimatePageHeightFromBoxes(boxes) : 792;
  const pageWidth =
    boxes.length > 0
      ? Math.max(
          estimatePageWidthFromBoxes(boxes),
          hit.urx,
          hit.llx,
          612,
        )
      : 612;
  const band = Math.max(24, pageHeight * FORWARD_EDGE_BAND_FRAC);
  // `--find` hit is PDF bottom-up; synctex boxes are top-down (like `--report`).
  const hitCyPdf = hitVerticalCenter(hit);
  const hitCy = pageHeight - hitCyPdf;
  const hitInEdge = hitCy < band || hitCy > pageHeight - band;
  const sameLineBoxes = summarizeSameLineBoxes(
    boxes,
    sourceFile,
    line,
    pageHeight,
    pageWidth,
  );
  const baseDiag = {
    raw: hit,
    pageHeight,
    pageWidth,
    band,
    hitCy,
    hitInEdge,
    sameLineCount: sameLineBoxes.length,
    sameLineBoxes,
    unitScale,
  };

  if (!hitInEdge) {
    // mtx already landed mid-page; keep its box (avoids expanding to a vbox).
    return {
      result: hit,
      diag: { ...baseDiag, chosen: hit, action: 'keep-raw' },
    };
  }
  const near = {
    x: (hit.llx + hit.urx) / 2,
    y: hitCy,
  };
  const preferred = pickForwardSameLineBox(
    boxes,
    sourceFile,
    line,
    near,
    pageHeight,
  );
  if (!preferred) {
    return {
      result: hit,
      diag: { ...baseDiag, chosen: hit, action: 'no-same-line' },
    };
  }
  const next = synctexBoxToFindResult(preferred, hit.page, pageHeight);
  const maxArea = pageHeight * pageWidth * FORWARD_MAX_BOX_PAGE_FRAC;
  if (hitArea(next) > maxArea && hitArea(next) > hitArea(hit) * 4) {
    return {
      result: hit,
      diag: { ...baseDiag, chosen: hit, action: 'oversized-skip' },
    };
  }
  const same =
    Math.abs(next.llx - hit.llx) < 0.5 &&
    Math.abs(next.lly - hit.lly) < 0.5 &&
    Math.abs(next.urx - hit.urx) < 0.5 &&
    Math.abs(next.ury - hit.ury) < 0.5;
  if (same) {
    return {
      result: hit,
      diag: { ...baseDiag, chosen: hit, action: 'keep-raw' },
    };
  }
  return {
    result: next,
    note: `forward edge-band refine (mtx llx=${hit.llx} lly=${hit.lly} → ${next.llx},${next.lly}; unitScale=${unitScale})`,
    diag: { ...baseDiag, chosen: next, action: 'refined' },
  };
}

export interface ForwardSyncInvokeResult
  extends SynctexInvokeResult<ForwardSyncResult> {
  /** First mtx `--find` box before edge-band refine. */
  raw: ForwardSyncResult;
  /** Edge-band refine diagnostics (for ConTeXt debug). */
  diag: ForwardRefineDiag;
  /** Extra `page=…` matches in mtx stdout beyond the first (rare). */
  extraHits: ForwardSyncResult[];
}

/** Collect every `page=… llx=…` record in mtx `--find` output (first is primary). */
export function parseAllFindHits(text: string): ForwardSyncResult[] {
  const re =
    /page\s*=\s*['"]?([-\d.]+)['"]?\s+llx\s*=\s*['"]?([-\d.]+)['"]?\s+lly\s*=\s*['"]?([-\d.]+)['"]?\s+urx\s*=\s*['"]?([-\d.]+)['"]?\s+ury\s*=\s*['"]?([-\d.]+)['"]?/gi;
  const hits: ForwardSyncResult[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hits.push({
      page: Number(m[1]),
      llx: Number(m[2]),
      lly: Number(m[3]),
      urx: Number(m[4]),
      ury: Number(m[5]),
    });
  }
  return hits;
}

/**
 * Forward SyncTeX: source file+line → PDF page and box.
 * Always runs with cwd = job/project directory against the project synctex file.
 * After mtx `--find`, edge-band hits may be refined to a nearer same-line box.
 */
export async function forwardSync(
  toolchain: Toolchain,
  synctexPath: string,
  sourceFile: string,
  line: number,
  jobDir: string,
): Promise<ForwardSyncInvokeResult> {
  const spec = buildFindArgs(synctexPath, sourceFile, line, jobDir);
  const { stdout, stderr, exitCode } = await runMtx(toolchain, spec.args, spec.cwd);
  const combined = `${stdout}\n${stderr}`;
  const allHits = parseAllFindHits(combined);
  const parsed = allHits[0] ?? parseFindOutput(combined);
  if (!parsed) {
    throw new SynctexError(
      `Forward SyncTeX produced no match (exit ${exitCode}) cwd=${spec.cwd} argv=${JSON.stringify(spec.args)}: ${combined.trim() || '(empty output)'}`,
    );
  }
  const refined = refineForwardHit(synctexPath, sourceFile, line, parsed);
  return {
    result: refined.result,
    raw: parsed,
    diag: refined.diag,
    extraHits: allHits.slice(1),
    argv: spec.args,
    cwd: spec.cwd,
    stdout,
    stderr,
    note: refined.note,
  };
}

export interface BackwardSyncOptions {
  /** First-pass `--tolerance` (default {@link DEFAULT_REPORT_TOLERANCE}). */
  tolerance?: number;
  /**
   * When the first pass is empty, retry once with this larger tolerance
   * (nearest-box snap via mtx). Use `0` to disable. Default {@link SNAP_REPORT_TOLERANCE}.
   */
  snapTolerance?: number;
  /**
   * When mtx returns a suspiciously low line for a mid-page click, try to
   * pick a nearer/smaller box from the synctex page (caption refinement).
   * Default true.
   */
  refineCoarseLines?: boolean;
}

function boxToResult(box: SynctexBox, toleranceUsed: number): BackwardSyncResult {
  return {
    filename: box.filename,
    linenumber: box.linenumber,
    tolerance: toleranceUsed,
    refined: true,
  };
}

function maybeRefineHit(
  synctexPath: string,
  page: number,
  x: number,
  y: number,
  hit: BackwardSyncResult,
  snapTolerance: number,
  refineCoarseLines: boolean,
): { hit: BackwardSyncResult; note?: string } {
  if (!refineCoarseLines || !isSuspiciousFileStartHit(hit.linenumber, y)) {
    return { hit };
  }
  const boxes = readSynctexPageBoxes(synctexPath, page);
  const better = nearestSynctexBox(boxes, x, y, Math.max(snapTolerance, DEFAULT_REPORT_TOLERANCE));
  if (better && better.linenumber > hit.linenumber) {
    return {
      hit: boxToResult(better, hit.tolerance),
      note: `refined coarse line ${hit.linenumber} → ${better.linenumber} (${better.filename})`,
    };
  }
  return {
    hit: { ...hit, coarseFloatLine: true },
    note: 'coarse float/caption line tag (engine limitation)',
  };
}

/**
 * Backward SyncTeX: PDF page+coords → source file+line.
 * Uses `--report --direct --console` with cwd = jobDir and the project synctex path.
 *
 * On empty stdout (typical for image/figure clicks with no SyncTeX boxes),
 * retries once with a larger `--tolerance` so mtx can snap to a nearby text
 * box, then falls back to parsing page boxes ourselves. Still throws
 * {@link SynctexError} with `kind: 'empty'` if all miss — never invents a
 * source line for image-only hits.
 *
 * When mtx returns line ≤ 1 for a mid-page click (common float/caption tag),
 * tries a nearer/smaller box from the same page; if nothing better exists,
 * sets `coarseFloatLine` so the UI can refuse the jump (message only).
 */
export async function backwardSync(
  toolchain: Toolchain,
  synctexPath: string,
  page: number,
  x: number,
  y: number,
  jobDir: string,
  toleranceOrOpts: number | BackwardSyncOptions = DEFAULT_REPORT_TOLERANCE,
): Promise<SynctexInvokeResult<BackwardSyncResult>> {
  const opts: BackwardSyncOptions =
    typeof toleranceOrOpts === 'number'
      ? { tolerance: toleranceOrOpts }
      : toleranceOrOpts;
  const tolerance = opts.tolerance ?? DEFAULT_REPORT_TOLERANCE;
  const snapTolerance = opts.snapTolerance ?? SNAP_REPORT_TOLERANCE;
  const refineCoarseLines = opts.refineCoarseLines !== false;
  const absSynctex = path.resolve(synctexPath);

  const finish = (
    hit: BackwardSyncResult,
    argv: string[],
    cwd: string,
    stdout: string,
    stderr: string,
  ): SynctexInvokeResult<BackwardSyncResult> => {
    const refined = maybeRefineHit(
      absSynctex,
      page,
      x,
      y,
      hit,
      snapTolerance,
      refineCoarseLines,
    );
    return {
      result: refined.hit,
      argv,
      cwd,
      stdout,
      stderr,
      note: refined.note,
    };
  };

  const first = await runReportOnce(toolchain, absSynctex, page, x, y, jobDir, tolerance);
  if (first.parsed) {
    return finish(first.parsed, first.spec.args, first.spec.cwd, first.stdout, first.stderr);
  }

  const firstCombined = `${first.stdout}\n${first.stderr}`;
  if (isInvalidSynctexLogMessage(firstCombined)) {
    throw new SynctexError(
      `Backward SyncTeX produced no match (exit ${first.exitCode}) cwd=${first.spec.cwd} argv=${JSON.stringify(first.spec.args)} (mtx-synctex rejected the log path — check cwd and synctex argv): ${firstCombined.trim() || '(empty output)'}`,
      'invalid',
    );
  }

  if (
    snapTolerance > tolerance &&
    isEmptyReportOutput(first.stdout, first.stderr)
  ) {
    const snap = await runReportOnce(
      toolchain,
      absSynctex,
      page,
      x,
      y,
      jobDir,
      snapTolerance,
    );
    if (snap.parsed) {
      return finish(snap.parsed, snap.spec.args, snap.spec.cwd, snap.stdout, snap.stderr);
    }

    // Local nearest-box parse (same tolerance) — cheap, no second mtx spawn beyond snap.
    const boxes = readSynctexPageBoxes(absSynctex, page);
    const local = nearestSynctexBox(boxes, x, y, snapTolerance);
    if (local) {
      return {
        result: boxToResult(local, snapTolerance),
        argv: snap.spec.args,
        cwd: snap.spec.cwd,
        stdout: snap.stdout,
        stderr: snap.stderr,
        note: `local nearest-box snap line=${local.linenumber}`,
      };
    }

    const snapCombined = `${snap.stdout}\n${snap.stderr}`;
    throw new SynctexError(
      `Backward SyncTeX produced no match (exit ${snap.exitCode}) cwd=${snap.spec.cwd} argv=${JSON.stringify(snap.spec.args)} (retried tolerance=${snapTolerance} after empty first pass): ${snapCombined.trim() || '(empty output)'}`,
      'empty',
    );
  }

  throw new SynctexError(
    `Backward SyncTeX produced no match (exit ${first.exitCode}) cwd=${first.spec.cwd} argv=${JSON.stringify(first.spec.args)}: ${firstCombined.trim() || '(empty output)'}`,
    isEmptyReportOutput(first.stdout, first.stderr) ? 'empty' : 'other',
  );
}

async function runReportOnce(
  toolchain: Toolchain,
  synctexPath: string,
  page: number,
  x: number,
  y: number,
  jobDir: string,
  tolerance: number,
): Promise<{
  spec: SynctexRunSpec;
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: BackwardSyncResult | undefined;
}> {
  const spec = buildReportArgs(synctexPath, page, x, y, jobDir, tolerance);
  const { stdout, stderr, exitCode } = await runMtx(toolchain, spec.args, spec.cwd);
  const parsed = parseReportOutput(`${stdout}\n${stderr}`);
  return { spec, stdout, stderr, exitCode, parsed };
}
