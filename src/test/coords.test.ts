import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pdfYToMtxY,
  mtxYToPdfY,
  mtxBoxToPdfBox,
  mtxBoxToCss,
  type PageBox,
} from '../synctex/coords';

/** Sir's ~680pt page (view box origin at 0). */
const page680: PageBox = { xMin: 0, yMin: 0, xMax: 595, yMax: 680 };

describe('mtx-synctex y-axis (top-down)', () => {
  it('maps a click near the top of the page to a small mtx y', () => {
    // PDF bottom-up: near top ≈ y=650 on a 680pt page
    const pdfYNearTop = 650;
    const mtxY = pdfYToMtxY(pdfYNearTop, page680);
    assert.ok(mtxY < 50, `expected small top-down y, got ${mtxY}`);
    assert.equal(mtxYToPdfY(mtxY, page680), pdfYNearTop);
  });

  it('maps a click near the bottom to a large mtx y', () => {
    const pdfYNearBottom = 40;
    const mtxY = pdfYToMtxY(pdfYNearBottom, page680);
    assert.ok(mtxY > 600, `expected large top-down y, got ${mtxY}`);
  });

  it('places line 116 (lly=538) below line 114 (lly=509) on a 680pt page', () => {
    // Sir: line 114 → lly=509; line 116 → lly=538 (later line = larger top-down y)
    const line114 = { llx: 304, lly: 509, urx: 344, ury: 524 };
    const line116 = { llx: 304, lly: 538, urx: 344, ury: 553 };

    const css114 = mtxBoxToCss(line114, 1);
    const css116 = mtxBoxToCss(line116, 1);
    assert.ok(
      css116.top > css114.top,
      `line 116 top ${css116.top} should be below line 114 top ${css114.top}`,
    );
    // Near page bottom relative to 680
    assert.ok(css116.top > 500);
    assert.ok(css116.top + css116.height < 680);

    const pdf114 = mtxBoxToPdfBox(line114, page680);
    const pdf116 = mtxBoxToPdfBox(line116, page680);
    // PDF bottom-up: lower on page ⇒ smaller y
    assert.ok(
      pdf116.ury < pdf114.ury,
      `PDF ury for line 116 (${pdf116.ury}) should be below line 114 (${pdf114.ury})`,
    );
  });

  it('round-trips pdfY ↔ mtxY', () => {
    for (const y of [0, 100, 340, 680]) {
      assert.equal(mtxYToPdfY(pdfYToMtxY(y, page680), page680), y);
    }
  });
});
