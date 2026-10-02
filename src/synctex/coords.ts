/**
 * ConTeXt mtx-synctex coordinate helpers.
 *
 * Conventions (from user retests after synctex-forward-y-fix-v2):
 * - `mtxrun --script synctex --find` returns boxes in SyncTeX top-down space
 *   (same as `.synctex` `h`/`r` after sp→pt). y increases downward from the
 *   page top. Do not treat these as PDF bottom-up.
 * - `mtxrun --script synctex --report --y` also expects top-down y. Reverse
 *   SyncTeX converts PDF.js bottom-up with `pageHeight - pdfY`.
 * - Raw `.synctex` `h`/`r` records are usually TeX scaled points and top-down;
 *   see `synctexUnitScaleToPt` in synctexBoxes.ts.
 * - Map SyncTeX pt × viewer scale (plus real crop origin). Do not stretch Y by
 *   `pageViewH / synctexPageH` — that pushed middle/bottom slightly too low.
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

export function pageWidth(box: PageBox): number {
  return box.xMax - box.xMin;
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
 * Normalize an mtx `--find` / synctex-space box (top-down y).
 * Ensures llx ≤ urx and lly ≤ ury (lly nearer page top when top-down).
 */
export function findBoxNormalize(box: MtxBox): MtxBox {
  return {
    llx: Math.min(box.llx, box.urx),
    urx: Math.max(box.llx, box.urx),
    lly: Math.min(box.lly, box.ury),
    ury: Math.max(box.lly, box.ury),
  };
}

/**
 * Map a SyncTeX top-down `--find` box into PDF user-space (bottom-up).
 * Uses SyncTeX pt as-is (plus crop origin). Optional `synctexPage` is ignored
 * for stretch — kept for call-site compatibility / debug.
 */
export function findBoxToPdfBox(
  box: MtxBox,
  pdfPage: PageBox,
  _synctexPage?: { width: number; height: number },
): MtxBox {
  const src = findBoxNormalize(box);
  return {
    llx: pdfPage.xMin + src.llx,
    urx: pdfPage.xMin + src.urx,
    // PDF: larger y is higher on the page
    lly: pdfPage.yMax - src.ury,
    ury: pdfPage.yMax - src.lly,
  };
}

/**
 * @deprecated Alias kept for older call sites; `--find` is top-down and must
 * be mapped with {@link findBoxToPdfBox} (needs the PDF page box).
 */
export function mtxBoxToPdfBox(box: MtxBox, page: PageBox): MtxBox {
  return findBoxToPdfBox(box, page);
}

/**
 * CSS/viewport box from an mtx `--find` top-down box at a given scale.
 * CSS y=0 is the page top: top = synctexY * scale (no pageViewH/synctexH stretch).
 * `pdfPage` / `_synctexPage` are kept for call-site compatibility; crop is applied
 * when mapping through PDF.js (`findBoxToPdfBox` / viewer `mtxFindBoxToViewport`).
 */
export function findBoxToCss(
  box: MtxBox,
  _pdfPage: PageBox,
  scale: number,
  _synctexPage?: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const src = findBoxNormalize(box);
  return {
    left: src.llx * scale,
    top: src.lly * scale,
    width: (src.urx - src.llx) * scale,
    height: (src.ury - src.lly) * scale,
  };
}

/**
 * @deprecated Use {@link findBoxToCss} with PDF + optional synctex page sizes.
 */
export function mtxBoxToCss(
  box: MtxBox,
  scale: number,
  page?: PageBox,
  synctexPage?: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (page) {
    return findBoxToCss(box, page, scale, synctexPage);
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
