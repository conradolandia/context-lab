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
import { FIND_BOX_VECTORS, PAGE_680 } from '../synctex/coordsVectors';

const page680: PageBox = PAGE_680;

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

  it('round-trips pdfY ↔ --report mtxY', () => {
    for (const y of [0, 100, 340, 680]) {
      assert.equal(mtxYToPdfY(pdfYToMtxY(y, page680), page680), y);
    }
  });
});

describe('find-box contract vectors (shared with viewer mirror)', () => {
  for (const v of FIND_BOX_VECTORS) {
    it(`${v.id}: findBoxToPdfBox / findBoxToCss match shared vectors`, () => {
      const pdf = findBoxToPdfBox(v.box, v.page);
      const css = findBoxToCss(v.box, v.page, v.scale);
      assert.deepEqual(pdf, v.pdf);
      assert.deepEqual(css, v.css);
      assert.deepEqual(mtxBoxToPdfBox(v.box, v.page), pdf);
    });
  }

  it('does not invert bottom hits into middle-top (classic wrong flip)', () => {
    const bottom = FIND_BOX_VECTORS.find((v) => v.id === 'bottom-hit')!;
    assert.ok(bottom.css.top > 480, `expected near bottom, got css.top=${bottom.css.top}`);
    assert.equal(findBoxNormalize(bottom.box).lly, 513);
  });

  it('maps synctex pt to CSS without pageViewH/synctexPageH stretch', () => {
    const mid = FIND_BOX_VECTORS.find((v) => v.id === 'mid-no-stretch')!;
    const synctex = { width: 595, height: 651.4 };
    const css = findBoxToCss(mid.box, mid.page, 1, synctex);
    assert.deepEqual(css, mid.css);
    const pdf = findBoxToPdfBox(mid.box, mid.page, synctex);
    assert.deepEqual(pdf, mid.pdf);
  });
});
