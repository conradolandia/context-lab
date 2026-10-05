/**
 * Shared SyncTeX coordinate contract vectors.
 *
 * Used by `coords.test.ts` (TypeScript helpers) and
 * `viewerFindBoxMirror.test.ts` (mirrors `media/viewer/viewer.js`
 * `mtxFindBoxToViewport` PDF-space math). Keep both suites green when
 * changing mapping rules — do not edit only one side.
 *
 * Conventions (preferences / coords.ts):
 * - `--find` boxes are SyncTeX top-down pt (sp÷65536); y grows downward.
 * - Map with scale / crop origin only — no pageViewH/synctexPageH stretch.
 * - Reverse `--report` still uses PDF bottom-up → top-down via pageH - pdfY.
 */

export interface ContractMtxBox {
  llx: number;
  lly: number;
  urx: number;
  ury: number;
}

export interface ContractPageBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface ContractCssBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FindBoxVector {
  id: string;
  /** PDF.js page.view / media box. */
  page: ContractPageBox;
  scale: number;
  /** Raw mtx `--find` box (top-down). */
  box: ContractMtxBox;
  /** Expected PDF user-space box after findBoxToPdfBox / viewer PDF remap. */
  pdf: ContractMtxBox;
  /** Expected CSS/viewport-ish box from findBoxToCss (scale only). */
  css: ContractCssBox;
}

/** ~680pt page (view box origin at 0), matching historical coords tests. */
export const PAGE_680: ContractPageBox = {
  xMin: 0,
  yMin: 0,
  xMax: 595,
  yMax: 680,
};

/**
 * Exact expected outputs for the SyncTeX top-down → PDF / CSS contract.
 * Viewer mirror must match `pdf`; TS `findBoxToCss` must match `css`.
 */
export const FIND_BOX_VECTORS: readonly FindBoxVector[] = [
  {
    id: 'top-hit',
    page: PAGE_680,
    scale: 1,
    box: { llx: 74, lly: 20, urx: 274, ury: 35 },
    pdf: { llx: 74, lly: 645, urx: 274, ury: 660 },
    css: { left: 74, top: 20, width: 200, height: 15 },
  },
  {
    id: 'mid-no-stretch',
    page: PAGE_680,
    scale: 1,
    box: { llx: 74, lly: 318, urx: 274, ury: 333 },
    pdf: { llx: 74, lly: 347, urx: 274, ury: 362 },
    css: { left: 74, top: 318, width: 200, height: 15 },
  },
  {
    id: 'higher-on-page',
    page: PAGE_680,
    scale: 1,
    box: { llx: 304, lly: 509, urx: 344, ury: 524 },
    pdf: { llx: 304, lly: 156, urx: 344, ury: 171 },
    css: { left: 304, top: 509, width: 40, height: 15 },
  },
  {
    id: 'lower-on-page',
    page: PAGE_680,
    scale: 1,
    box: { llx: 304, lly: 538, urx: 344, ury: 553 },
    pdf: { llx: 304, lly: 127, urx: 344, ury: 142 },
    css: { left: 304, top: 538, width: 40, height: 15 },
  },
  {
    id: 'bottom-hit',
    page: PAGE_680,
    scale: 1,
    box: { llx: 74, lly: 513, urx: 274, ury: 528 },
    pdf: { llx: 74, lly: 152, urx: 274, ury: 167 },
    css: { left: 74, top: 513, width: 200, height: 15 },
  },
  {
    id: 'scaled-2x',
    page: PAGE_680,
    scale: 2,
    box: { llx: 74, lly: 20, urx: 274, ury: 35 },
    pdf: { llx: 74, lly: 645, urx: 274, ury: 660 },
    css: { left: 148, top: 40, width: 400, height: 30 },
  },
  {
    id: 'crop-origin',
    page: { xMin: 10, yMin: 5, xMax: 605, yMax: 685 },
    scale: 1,
    box: { llx: 74, lly: 20, urx: 274, ury: 35 },
    pdf: { llx: 84, lly: 650, urx: 284, ury: 665 },
    css: { left: 74, top: 20, width: 200, height: 15 },
  },
];
