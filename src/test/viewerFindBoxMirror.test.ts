/**
 * Mirrored contract checks for media/viewer/viewer.js `mtxFindBoxToViewport`.
 *
 * The webview cannot import TypeScript; this suite re-implements the viewer's
 * PDF-space remap (before PDF.js convertToViewportPoint) and asserts it stays
 * equivalent to `findBoxToPdfBox` and the shared vectors in coordsVectors.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findBoxToPdfBox, findBoxToCss, type PageBox } from '../synctex/coords';
import {
  FIND_BOX_VECTORS,
  type ContractMtxBox,
  type ContractPageBox,
} from '../synctex/coordsVectors';

/**
 * Mirror of viewer.js mtxFindBoxToViewport PDF-space step (lines ~293–304):
 * SyncTeX top-down pt + crop origin → PDF bottom-up box, no stretch.
 */
function viewerMtxFindBoxToPdf(
  box: ContractMtxBox,
  pageView: [number, number, number, number],
): ContractMtxBox {
  const xMin = pageView[0] ?? 0;
  const yMax = pageView[3] ?? 792;
  const topFromTop = Math.min(box.lly, box.ury);
  const bottomFromTop = Math.max(box.lly, box.ury);
  return {
    llx: xMin + Math.min(box.llx, box.urx),
    urx: xMin + Math.max(box.llx, box.urx),
    lly: yMax - bottomFromTop,
    ury: yMax - topFromTop,
  };
}

function pageToView(page: ContractPageBox): [number, number, number, number] {
  return [page.xMin, page.yMin, page.xMax, page.yMax];
}

function asPageBox(page: ContractPageBox): PageBox {
  return page;
}

describe('viewer mtxFindBoxToViewport mirror vs coords.ts', () => {
  for (const v of FIND_BOX_VECTORS) {
    it(`${v.id}: viewer PDF remap matches findBoxToPdfBox and vector.pdf`, () => {
      const fromViewer = viewerMtxFindBoxToPdf(v.box, pageToView(v.page));
      const fromTs = findBoxToPdfBox(v.box, asPageBox(v.page));
      assert.deepEqual(fromViewer, v.pdf, 'viewer mirror vs vector.pdf');
      assert.deepEqual(fromTs, v.pdf, 'findBoxToPdfBox vs vector.pdf');
      assert.deepEqual(fromViewer, fromTs, 'viewer mirror vs findBoxToPdfBox');
    });

    it(`${v.id}: findBoxToCss matches vector.css (scale only)`, () => {
      const css = findBoxToCss(v.box, asPageBox(v.page), v.scale);
      assert.deepEqual(css, v.css);
      // Viewer diagnostic simpleMtxCssTop = min(lly,ury) * scale
      assert.equal(Math.min(v.box.lly, v.box.ury) * v.scale, v.css.top);
    });
  }

  it('places lower-on-page CSS below higher-on-page (ordering)', () => {
    const higher = FIND_BOX_VECTORS.find((v) => v.id === 'higher-on-page')!;
    const lower = FIND_BOX_VECTORS.find((v) => v.id === 'lower-on-page')!;
    assert.ok(lower.css.top > higher.css.top);
  });
});
