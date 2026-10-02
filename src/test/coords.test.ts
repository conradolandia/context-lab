import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pdfYToMtxY,
  mtxYToPdfY,
  findBoxToPdfBox,
  findBoxToCss,
  findBoxNormalize,
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

  it('treats --find boxes as SyncTeX top-down (small lly → CSS near top)', () => {
    // Retest: --find aligns with same-line synctex y (top-down), not PDF bottom-up.
    const topHit = { llx: 74, lly: 20, urx: 274, ury: 35 };
    const css = findBoxToCss(topHit, page680, 1);
    assert.ok(css.top < 40, `expected near CSS top, got ${css.top}`);
    assert.ok(css.top + css.height < 55);

    const pdf = findBoxToPdfBox(topHit, page680);
    // PDF bottom-up: near top → high y
    assert.ok(pdf.ury > 640, `expected PDF-near-top ury, got ${pdf.ury}`);
    assert.deepEqual(mtxBoxToPdfBox(topHit, page680), pdf);
  });

  it('scales synctex pageH into PDF.js pageViewH', () => {
    // Trace: synctex pageH≈651.4 vs pageView H≈680.3
    const synctex = { width: 595, height: 651.4 };
    const mid = { llx: 74, lly: 318, urx: 274, ury: 333 };
    const css = findBoxToCss(mid, page680, 1, synctex);
    const expectedTop = 318 * (680 / 651.4);
    assert.ok(
      Math.abs(css.top - expectedTop) < 0.5,
      `expected css.top≈${expectedTop}, got ${css.top}`,
    );
  });

  it('places a lower-on-page --find box below a higher one in CSS', () => {
    // Top-down: larger lly is lower on the page
    const higher = { llx: 304, lly: 509, urx: 344, ury: 524 };
    const lower = { llx: 304, lly: 538, urx: 344, ury: 553 };
    const cssHigh = findBoxToCss(higher, page680, 1);
    const cssLow = findBoxToCss(lower, page680, 1);
    assert.ok(
      cssLow.top > cssHigh.top,
      `lower box top ${cssLow.top} should be below higher ${cssHigh.top}`,
    );
  });

  it('does not invert bottom hits into middle-top (classic wrong flip)', () => {
    // Bottom lly=513 must not become cssTop≈190 via (pageH-ury).
    const bottom = { llx: 74, lly: 513, urx: 274, ury: 528 };
    const css = findBoxToCss(bottom, page680, 1);
    assert.ok(css.top > 480, `expected near bottom, got css.top=${css.top}`);
    assert.ok(findBoxNormalize(bottom).lly === 513);
  });

  it('round-trips pdfY ↔ --report mtxY', () => {
    for (const y of [0, 100, 340, 680]) {
      assert.equal(mtxYToPdfY(pdfYToMtxY(y, page680), page680), y);
    }
  });
});
