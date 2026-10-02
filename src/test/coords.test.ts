import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pdfYToMtxY,
  mtxYToPdfY,
  findBoxToPdfBox,
  findBoxToCss,
  mtxBoxToPdfBox,
  type PageBox,
} from '../synctex/coords';

/** ~680pt page (view box origin at 0). */
const page680: PageBox = { xMin: 0, yMin: 0, xMax: 595, yMax: 680 };

describe('mtx-synctex y-axis', () => {
  it('maps a PDF click near the top to a small --report (top-down) y', () => {
    // PDF bottom-up: near top ≈ y=650 on a 680pt page
    const pdfYNearTop = 650;
    const mtxY = pdfYToMtxY(pdfYNearTop, page680);
    assert.ok(mtxY < 50, `expected small top-down y, got ${mtxY}`);
    assert.equal(mtxYToPdfY(mtxY, page680), pdfYNearTop);
  });

  it('maps a PDF click near the bottom to a large --report (top-down) y', () => {
    const pdfYNearBottom = 40;
    const mtxY = pdfYToMtxY(pdfYNearBottom, page680);
    assert.ok(mtxY > 600, `expected large top-down y, got ${mtxY}`);
  });

  it('treats --find boxes as PDF bottom-up (near-top lly stays near CSS top)', () => {
    // Trace: top-of-page --find llx=74 lly=634 urx=274 ury=649 on ~680pt page
    const topHit = { llx: 74, lly: 634, urx: 274, ury: 649 };
    const css = findBoxToCss(topHit, page680, 1);
    assert.ok(css.top < 60, `expected near CSS top, got ${css.top}`);
    assert.ok(css.top + css.height < 80);

    const pdf = findBoxToPdfBox(topHit);
    assert.equal(pdf.lly, 634);
    assert.equal(pdf.ury, 649);
    // Deprecated wrapper must not flip
    assert.deepEqual(mtxBoxToPdfBox(topHit, page680), pdf);
  });

  it('places a lower-on-page --find box below a higher one in CSS', () => {
    // PDF bottom-up: larger y is higher on the page
    const higher = { llx: 304, lly: 538, urx: 344, ury: 553 };
    const lower = { llx: 304, lly: 509, urx: 344, ury: 524 };
    const cssHigh = findBoxToCss(higher, page680, 1);
    const cssLow = findBoxToCss(lower, page680, 1);
    assert.ok(
      cssLow.top > cssHigh.top,
      `lower box top ${cssLow.top} should be below higher ${cssHigh.top}`,
    );
  });

  it('round-trips pdfY ↔ --report mtxY', () => {
    for (const y of [0, 100, 340, 680]) {
      assert.equal(mtxYToPdfY(pdfYToMtxY(y, page680), page680), y);
    }
  });
});
