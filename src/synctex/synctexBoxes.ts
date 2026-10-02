import * as fs from 'node:fs';

/**
 * One ConTeXt SyncTeX content box (`h` / `r` records from the `.synctex` file).
 * Raw file values are usually TeX scaled points (see {@link SYNCTEX_SP_PER_PT});
 * y increases downward from the page top (SyncTeX / mtx `--report` convention).
 * These are not mtx `--find` boxes (`--find` returns PDF bottom-up points).
 */
export interface SynctexBox {
  fileId: string;
  filename: string;
  linenumber: number;
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
}

/**
 * TeX scaled points per PostScript point. Classic SyncTeX with
 * Magnification:1000 and Unit:1 stores dimensions as `pt * 65536`.
 */
export const SYNCTEX_SP_PER_PT = 65536;

/** Upper bound for a page height already expressed in points (fixtures / rare tools). */
const PAGE_HEIGHT_PT_MAX = 20_000;

/** Plausible page height in points after dividing raw synctex coords by 65536. */
const PAGE_HEIGHT_PT_MIN_AFTER_SP = 50;
const PAGE_HEIGHT_PT_MAX_AFTER_SP = 5000;

const INPUT_RE = /^Input:(.+?):(.+)$/;
const PAGE_START_RE = /^\{(\d+)/;
const BOX_RE =
  /^[hr]([^,]+),([^:]+):([^,]+),([^:]+):([^,]+),([^,]+),(.+)$/;

/**
 * Parse ConTeXt-style `.synctex` text for boxes on one page.
 * Returns [] when the page is missing or the file is not ConTeXt text synctex.
 */
export function parseSynctexPageBoxes(
  text: string,
  page: number,
): SynctexBox[] {
  const files = new Map<string, string>();
  const boxes: SynctexBox[] = [];
  let onPage = false;
  let skip = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const input = INPUT_RE.exec(line);
    if (input) {
      files.set(input[1], input[2]);
      continue;
    }
    if (skip) {
      if (line.startsWith('}')) {
        skip = false;
      }
      continue;
    }
    const pageStart = PAGE_START_RE.exec(line);
    if (pageStart) {
      const p = Number(pageStart[1]);
      if (p === page) {
        onPage = true;
      } else {
        onPage = false;
        skip = true;
      }
      continue;
    }
    if (!onPage) {
      continue;
    }
    if (line.startsWith('}')) {
      onPage = false;
      continue;
    }
    const m = BOX_RE.exec(line);
    if (!m) {
      continue;
    }
    const fileId = m[1];
    const linenumber = Number(m[2]);
    const x = Number(m[3]);
    const y = Number(m[4]);
    const w = Number(m[5]);
    const h = Number(m[6]);
    const d = Number(m[7]);
    if (!Number.isFinite(linenumber) || linenumber <= 0) {
      continue;
    }
    const filename = files.get(fileId);
    if (!filename) {
      continue;
    }
    boxes.push({ fileId, filename, linenumber, x, y, w, h, d });
  }
  return boxes;
}

export function readSynctexPageBoxes(
  synctexPath: string,
  page: number,
): SynctexBox[] {
  let text: string;
  try {
    text = fs.readFileSync(synctexPath, 'utf8');
  } catch {
    return [];
  }
  // Compressed .synctex.gz is not handled here (extension prefers plain .synctex).
  if (text.charCodeAt(0) === 0x1f) {
    return [];
  }
  return parseSynctexPageBoxes(text, page);
}

/**
 * Scale factor that converts raw `.synctex` box coords → PDF / mtx `--find` points.
 * Returns `1` when boxes already look pt-sized, `65536` when they look like sp,
 * or `null` when conversion is ambiguous (caller should skip refine).
 */
export function synctexUnitScaleToPt(
  boxes: SynctexBox[],
  hit?: { llx: number; lly: number; urx: number; ury: number },
): number | null {
  if (boxes.length === 0) {
    return null;
  }
  const pageH = estimatePageHeightFromBoxes(boxes, 0);
  if (!(pageH > 0)) {
    return null;
  }
  // Test fixtures and some dumps already store pt-sized numbers.
  if (pageH <= PAGE_HEIGHT_PT_MAX) {
    return 1;
  }
  const pageHpt = pageH / SYNCTEX_SP_PER_PT;
  if (
    pageHpt < PAGE_HEIGHT_PT_MIN_AFTER_SP ||
    pageHpt > PAGE_HEIGHT_PT_MAX_AFTER_SP
  ) {
    return null;
  }
  if (hit) {
    const hitMax = Math.max(
      Math.abs(hit.llx),
      Math.abs(hit.lly),
      Math.abs(hit.urx),
      Math.abs(hit.ury),
    );
    // `--find` is in pt; if the hit dwarfs the converted page, units are unknown.
    if (hitMax > pageHpt * 5) {
      return null;
    }
  }
  return SYNCTEX_SP_PER_PT;
}

/** Divide raw synctex box dimensions by `unitScale` (1 or {@link SYNCTEX_SP_PER_PT}). */
export function scaleSynctexBox(box: SynctexBox, unitScale: number): SynctexBox {
  if (unitScale === 1) {
    return box;
  }
  return {
    ...box,
    x: box.x / unitScale,
    y: box.y / unitScale,
    w: box.w / unitScale,
    h: box.h / unitScale,
    d: box.d / unitScale,
  };
}

function boxContains(box: SynctexBox, x: number, y: number): boolean {
  return (
    x >= box.x &&
    x <= box.x + box.w &&
    y >= box.y - box.d &&
    y <= box.y + box.h
  );
}

/** Chebyshev-ish distance to box (0 if inside); used for nearest-box snap. */
export function distanceToBox(box: SynctexBox, x: number, y: number): number {
  if (boxContains(box, x, y)) {
    return 0;
  }
  const dx =
    x < box.x ? box.x - x : x > box.x + box.w ? x - (box.x + box.w) : 0;
  const yLo = box.y - box.d;
  const yHi = box.y + box.h;
  const dy = y < yLo ? yLo - y : y > yHi ? y - yHi : 0;
  return Math.hypot(dx, dy);
}

/**
 * Nearest box within `tolerance` of (x, y). Prefer smaller area on ties so a
 * caption/word box beats a large float wrapper tagged at line 1.
 */
export function nearestSynctexBox(
  boxes: SynctexBox[],
  x: number,
  y: number,
  tolerance: number,
): SynctexBox | undefined {
  let best: SynctexBox | undefined;
  let bestDist = Infinity;
  let bestArea = Infinity;
  for (const box of boxes) {
    const dist = distanceToBox(box, x, y);
    if (dist > tolerance) {
      continue;
    }
    const area = Math.max(box.w, 0) * Math.max(box.h + box.d, 0);
    if (
      dist < bestDist - 1e-9 ||
      (Math.abs(dist - bestDist) <= 1e-9 && area < bestArea)
    ) {
      best = box;
      bestDist = dist;
      bestArea = area;
    }
  }
  return best;
}

/** Mid-page click with a file-start line is a common float/caption tag artifact. */
export const SUSPICIOUS_TOP_LINE_MAX = 1;

/** mtx y (top-down): clicks below this are treated as mid-page / not file-header. */
export const MID_PAGE_MTX_Y_MIN = 72;

export function isSuspiciousFileStartHit(
  linenumber: number,
  mtxY: number,
): boolean {
  return linenumber <= SUSPICIOUS_TOP_LINE_MAX && mtxY >= MID_PAGE_MTX_Y_MIN;
}

export const COARSE_FLOAT_LINE_USER_MESSAGE =
  'No useful SyncTeX match here — ConTeXt often tags float/caption boxes with a coarse line (file start). Click nearby body text for a precise jump.';

/**
 * Fraction of estimated page height treated as a thin header/footer band when
 * picking among forward SyncTeX boxes for the same source line. Not a real
 * header/footer detector — only biases away from edge landings.
 */
export const FORWARD_EDGE_BAND_FRAC = 0.08;

/**
 * Ignore same-line boxes larger than this fraction of estimated page area when
 * any smaller candidate exists — page-sized vboxes paint as a solid fill overlay.
 */
export const FORWARD_MAX_BOX_PAGE_FRAC = 0.2;

export function boxVerticalCenter(box: SynctexBox): number {
  const yLo = box.y - box.d;
  const yHi = box.y + box.h;
  return (yLo + yHi) / 2;
}

export function boxArea(box: SynctexBox): number {
  return Math.max(box.w, 0) * Math.max(box.h + box.d, 0);
}

/** Rough page height from boxes on the page (synctex y top-down, file units). */
export function estimatePageHeightFromBoxes(
  boxes: SynctexBox[],
  fallback = 792,
): number {
  let max = 0;
  for (const b of boxes) {
    max = Math.max(max, b.y + b.h, b.y + b.d);
  }
  return max > 0 ? max : fallback;
}

/** Rough page width from boxes on the page. */
export function estimatePageWidthFromBoxes(
  boxes: SynctexBox[],
  fallback = 612,
): number {
  let max = 0;
  for (const b of boxes) {
    max = Math.max(max, b.x + b.w);
  }
  return max > 0 ? max : fallback;
}

function normalizeSynctexPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** Match synctex Input paths against the editor path (relative or basename). */
export function synctexFilenamesMatch(a: string, b: string): boolean {
  const na = normalizeSynctexPath(a);
  const nb = normalizeSynctexPath(b);
  if (na === nb) {
    return true;
  }
  if (na.endsWith('/' + nb) || nb.endsWith('/' + na)) {
    return true;
  }
  const ba = na.split('/').pop() ?? na;
  const bb = nb.split('/').pop() ?? nb;
  return ba === bb && ba.length > 0;
}

export function isOversizedForwardBox(
  box: SynctexBox,
  pageHeight: number,
  pageWidth: number,
): boolean {
  const pageArea = Math.max(1, pageHeight * pageWidth);
  return boxArea(box) > pageArea * FORWARD_MAX_BOX_PAGE_FRAC;
}

/**
 * Among boxes for the same source file+line: skip page-sized boxes when a
 * compact candidate exists; prefer hits outside a thin top/bottom band; among
 * remaining candidates pick closest to `near` (mtx `--find` point), then
 * smaller area. Does not bias toward the page vertical middle.
 */
export function pickForwardSameLineBox(
  boxes: SynctexBox[],
  sourceFile: string,
  line: number,
  near?: { x: number; y: number },
  pageHeight?: number,
): SynctexBox | undefined {
  const matching = boxes.filter(
    (b) => b.linenumber === line && synctexFilenamesMatch(b.filename, sourceFile),
  );
  if (matching.length === 0) {
    return undefined;
  }
  const h = pageHeight ?? estimatePageHeightFromBoxes(boxes);
  const w = estimatePageWidthFromBoxes(boxes);
  const band = Math.max(24, h * FORWARD_EDGE_BAND_FRAC);
  const refX = near?.x ?? w / 2;
  const refY = near?.y ?? h / 2;

  const compact = matching.filter((b) => !isOversizedForwardBox(b, h, w));
  const pool = compact.length > 0 ? compact : matching;

  let best: SynctexBox | undefined;
  let bestInEdge = true;
  let bestDist = Infinity;
  let bestArea = Infinity;

  for (const box of pool) {
    const cy = boxVerticalCenter(box);
    const inEdge = cy < band || cy > h - band;
    const dist = distanceToBox(box, refX, refY);
    const area = boxArea(box);
    const better =
      !best ||
      (bestInEdge && !inEdge) ||
      (inEdge === bestInEdge &&
        (dist < bestDist - 1e-9 ||
          (Math.abs(dist - bestDist) <= 1e-9 && area < bestArea)));
    if (better) {
      best = box;
      bestInEdge = inEdge;
      bestDist = dist;
      bestArea = area;
    }
  }
  return best;
}
