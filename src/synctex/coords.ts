/**
 * ConTeXt mtx-synctex CLI y-axis helpers.
 *
 * Empirically (and consistent with Sir's logs), mtxrun --script synctex
 * --report/--find exchange y in a top-down page frame (y=0 at the top,
 * increasing downward). PDF.js convertToPdfPoint is bottom-up. Convert at
 * the boundary; x is the same in both systems.
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

/** PDF bottom-up y → mtx-synctex top-down y (from page top). */
export function pdfYToMtxY(pdfY: number, box: PageBox): number {
  return box.yMax - pdfY;
}

/** mtx-synctex top-down y → PDF bottom-up y. */
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
 * Convert an mtx-synctex forward box (top-down y) to PDF user-space corners
 * suitable for PDF.js convertToViewportPoint.
 *
 * mtx: top = min(lly,ury), bottom = max(lly,ury) measured from page top.
 */
export function mtxBoxToPdfBox(box: MtxBox, page: PageBox): MtxBox {
  const topFromTop = Math.min(box.lly, box.ury);
  const bottomFromTop = Math.max(box.lly, box.ury);
  return {
    llx: box.llx,
    urx: box.urx,
    // PDF: larger y is higher on the page
    lly: mtxYToPdfY(bottomFromTop, page),
    ury: mtxYToPdfY(topFromTop, page),
  };
}

/** CSS/viewport box from mtx top-down coordinates at a given scale (no viewBox offset). */
export function mtxBoxToCss(
  box: MtxBox,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  const topFromTop = Math.min(box.lly, box.ury);
  const bottomFromTop = Math.max(box.lly, box.ury);
  return {
    left: Math.min(box.llx, box.urx) * scale,
    top: topFromTop * scale,
    width: Math.abs(box.urx - box.llx) * scale,
    height: (bottomFromTop - topFromTop) * scale,
  };
}
