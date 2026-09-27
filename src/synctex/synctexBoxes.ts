import * as fs from 'node:fs';

/**
 * One ConTeXt SyncTeX content box (`h` / `r` records from mtx-synctex).
 * Coordinates match mtx-synctex (y top-down on the page).
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
  'SyncTeX jumped to the start of that file — ConTeXt often tags float/caption boxes with a coarse line. Click nearby body text for a more precise jump.';
