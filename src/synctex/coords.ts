/**
 * ConTeXt mtx-synctex coordinate helpers.
 *
 * Conventions (from user retests after synctex-forward-y-fix-v1):
 * - `mtxrun --script synctex --find` returns boxes in SyncTeX top-down space
 *   (same as `.synctex` `h`/`r` after sp→pt). y increases downward from the
 *   page top. Do not treat these as PDF bottom-up.
 * - `mtxrun --script synctex --report --y` also expects top-down y. Reverse
 *   SyncTeX converts PDF.js bottom-up with `pageHeight - pdfY`.
 * - Raw `.synctex` `h`/`r` records are usually TeX scaled points and top-down;
 *   see `synctexUnitScaleToPt` in synctexBoxes.ts.
 * - Synctex page size (from boxes) can differ from PDF.js `page.view`
 *   (e.g. ~651 vs ~680). Scale when mapping to the canvas.
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
 * Map a SyncTeX top-down `--find` box into PDF user-space (bottom-up),
 * scaling from synctex page size to the PDF.js page view box.
 */
export function findBoxToPdfBox(
  box: MtxBox,
  pdfPage: PageBox,
  synctexPage?: { width: number; height: number },
): MtxBox {
  const src = findBoxNormalize(box);
  const pdfW = pageWidth(pdfPage);
  const pdfH = pageHeight(pdfPage);
  const sx =
    synctexPage && synctexPage.width > 0 ? pdfW / synctexPage.width : 1;
  const sy =
    synctexPage && synctexPage.height > 0 ? pdfH / synctexPage.height : 1;
  const topFromTop = src.lly * sy;
  const bottomFromTop = src.ury * sy;
  return {
    llx: pdfPage.xMin + src.llx * sx,
    urx: pdfPage.xMin + src.urx * sx,
    // PDF: larger y is higher on the page
    lly: pdfPage.yMax - bottomFromTop,
    ury: pdfPage.yMax - topFromTop,
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
 * CSS/viewport box from an mtx `--find` top-down box at a given scale,
 * mapping synctex page size → PDF page view size.
 * CSS y=0 is the page top: top = synctexY * (pdfH/synctexH) * scale.
 */
export function findBoxToCss(
  box: MtxBox,
  pdfPage: PageBox,
  scale: number,
  synctexPage?: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const src = findBoxNormalize(box);
  const pdfW = pageWidth(pdfPage);
  const pdfH = pageHeight(pdfPage);
  const sx =
    synctexPage && synctexPage.width > 0 ? pdfW / synctexPage.width : 1;
  const sy =
    synctexPage && synctexPage.height > 0 ? pdfH / synctexPage.height : 1;
  return {
    left: src.llx * sx * scale,
    top: src.lly * sy * scale,
    width: (src.urx - src.llx) * sx * scale,
    height: (src.ury - src.lly) * sy * scale,
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
