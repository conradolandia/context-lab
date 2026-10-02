/**
 * ConTeXt mtx-synctex coordinate helpers.
 *
 * Conventions (from user traces + reverse SyncTeX path):
 * - `mtxrun --script synctex --find` returns boxes in PDF user space
 *   (y bottom-up, y=0 at page bottom). Pass those straight to PDF.js.
 * - `mtxrun --script synctex --report --y` expects top-down y
 *   (y=0 at page top). Reverse SyncTeX converts with `pageHeight - pdfY`.
 * - Raw `.synctex` `h`/`r` records are usually TeX scaled points and top-down;
 *   see `synctexUnitScaleToPt` in synctexBoxes.ts.
 */

export interface PageBox {
  /** Media/crop box lower-left x (PDF user space). */
  xMin: number;
  /** Media/crop box lower-left y (PDF user space). */
  yMin: number;
  /** Media/crop box upper-right x. */
  xMax: number;
  /** Media/crop box upper-right y. */
  yMax: number;
}

export function pageHeight(box: PageBox): number {
  return box.yMax - box.yMin;
}

/** PDF bottom-up y → mtx-synctex `--report` top-down y (from page top). */
export function pdfYToMtxY(pdfY: number, box: PageBox): number {
  return box.yMax - pdfY;
}

/** mtx-synctex `--report` top-down y → PDF bottom-up y. */
export function mtxYToPdfY(mtxY: number, box: PageBox): number {
  return box.yMax - mtxY;
}

export interface MtxBox {
  llx: number;
  lly: number;
  urx: number;
  ury: number;
}

/**
 * Normalize an mtx `--find` box already in PDF user space (bottom-up y).
 * Ensures lly ≤ ury for PDF.js convertToViewportPoint callers.
 */
export function findBoxToPdfBox(box: MtxBox): MtxBox {
  return {
    llx: Math.min(box.llx, box.urx),
    urx: Math.max(box.llx, box.urx),
    lly: Math.min(box.lly, box.ury),
    ury: Math.max(box.lly, box.ury),
  };
}

/**
 * @deprecated Use {@link findBoxToPdfBox}. `--find` boxes are already PDF
 * bottom-up; this used to wrongly treat them as top-down.
 */
export function mtxBoxToPdfBox(box: MtxBox, _page: PageBox): MtxBox {
  return findBoxToPdfBox(box);
}

/**
 * CSS/viewport box from an mtx `--find` PDF bottom-up box at a given scale.
 * CSS y=0 is the page top: top = (yMax - pdfTop) * scale.
 */
export function findBoxToCss(
  box: MtxBox,
  page: PageBox,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  const pdf = findBoxToPdfBox(box);
  return {
    left: (pdf.llx - page.xMin) * scale,
    top: (page.yMax - pdf.ury) * scale,
    width: (pdf.urx - pdf.llx) * scale,
    height: (pdf.ury - pdf.lly) * scale,
  };
}

/**
 * @deprecated Use {@link findBoxToCss} with a page box. Old helper assumed
 * top-down `--find` y and ignored the page height flip.
 */
export function mtxBoxToCss(
  box: MtxBox,
  scale: number,
  page?: PageBox,
): { left: number; top: number; width: number; height: number } {
  if (page) {
    return findBoxToCss(box, page, scale);
  }
  // Legacy path without page: treat numbers as already CSS-top-ish (tests only).
  const topFromTop = Math.min(box.lly, box.ury);
  const bottomFromTop = Math.max(box.lly, box.ury);
  return {
    left: Math.min(box.llx, box.urx) * scale,
    top: topFromTop * scale,
    width: Math.abs(box.urx - box.llx) * scale,
    height: (bottomFromTop - topFromTop) * scale,
  };
}
