import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseFindOutput,
  parseAllFindHits,
  parseReportOutput,
  buildFindArgs,
  buildReportArgs,
  synctexSourceArg,
  unquoteSynctexValue,
  isInvalidSynctexLogMessage,
  isEmptyReportOutput,
  EMPTY_BACKWARD_USER_MESSAGE,
  COARSE_FLOAT_LINE_USER_MESSAGE,
  DEFAULT_REPORT_TOLERANCE,
  SNAP_REPORT_TOLERANCE,
  SynctexError,
  parseSynctexPageBoxes,
  nearestSynctexBox,
  pickForwardSameLineBox,
  synctexFilenamesMatch,
  isSuspiciousFileStartHit,
  distanceToBox,
  FORWARD_EDGE_BAND_FRAC,
  FORWARD_MAX_BOX_PAGE_FRAC,
  refineForwardHit,
  synctexUnitScaleToPt,
  pickForwardNonEdgeFallbackBox,
  SYNCTEX_SP_PER_PT,
} from '../synctex/mtxSynctex';

const fixturesDir = path.join(__dirname, 'fixtures');

function readFixture(name: string): string {
  const candidates = [
    path.join(fixturesDir, name),
    path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return fs.readFileSync(c, 'utf8');
    }
  }
  throw new Error(`fixture not found: ${name}`);
}

describe('mtxSynctex parseFindOutput', () => {
  it('parses --direct find output', () => {
    const text = readFixture('find-direct.txt');
    const hit = parseFindOutput(text);
    assert.ok(hit);
    assert.equal(hit!.page, 1);
    assert.equal(hit!.llx, 72.5);
    assert.equal(hit!.lly, 680.25);
    assert.equal(hit!.urx, 300);
    assert.equal(hit!.ury, 700.5);
  });

  it('parses find output with mtx-synctex reporter prefix', () => {
    const text = readFixture('find-prefixed.txt');
    const hit = parseFindOutput(text);
    assert.ok(hit);
    assert.equal(hit!.page, 2);
    assert.equal(hit!.llx, 100);
  });

  it('returns undefined for empty / unrelated output', () => {
    assert.equal(parseFindOutput(''), undefined);
    assert.equal(parseFindOutput('mtx-synctex | nothing found'), undefined);
  });

  it('parseAllFindHits collects every page= box in stdout', () => {
    const text =
      'page=1 llx=10 lly=20 urx=30 ury=40\n' +
      'noise\n' +
      "page='2' llx='50' lly='60' urx='70' ury='80'\n";
    const hits = parseAllFindHits(text);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].page, 1);
    assert.equal(hits[0].llx, 10);
    assert.equal(hits[1].page, 2);
    assert.equal(hits[1].urx, 70);
    assert.deepEqual(parseAllFindHits('nothing'), []);
  });
});

describe('mtxSynctex parseReportOutput', () => {
  it('parses --direct report output (bare values)', () => {
    const text = readFixture('report-direct.txt');
    const hit = parseReportOutput(text);
    assert.ok(hit);
    assert.equal(hit!.filename, 'chapter.tex');
    assert.equal(hit!.linenumber, 42);
    assert.equal(hit!.tolerance, 0);
  });

  it('parses report output with absolute path and prefix', () => {
    const text = readFixture('report-prefixed.txt');
    const hit = parseReportOutput(text);
    assert.ok(hit);
    assert.equal(hit!.filename, '/home/andi/doc/main.tex');
    assert.equal(hit!.linenumber, 17);
    assert.equal(hit!.tolerance, 3);
  });

  it("parses Sir's quoted --direct line (filename='…' linenumber='…')", () => {
    const text = readFixture('report-quoted.txt');
    const hit = parseReportOutput(text);
    assert.ok(hit);
    assert.equal(hit!.filename, 'include/contenido/00-1-dedicatoria.tex');
    assert.equal(hit!.linenumber, 2);
    assert.equal(hit!.tolerance, 0);
  });

  it('parses --direct --console space-separated form ("path" line tol)', () => {
    const text = readFixture('report-console.txt');
    const hit = parseReportOutput(text);
    assert.ok(hit);
    assert.equal(hit!.filename, 'include/contenido/00-1-dedicatoria.tex');
    assert.equal(hit!.linenumber, 2);
    assert.equal(hit!.tolerance, 11);
  });

  it('parses console form when embedded after argv error suffix noise', () => {
    const text =
      'Backward SyncTeX produced no match (exit 0) argv=[...]: "include/contenido/00-1-dedicatoria.tex" 2 11\n';
    const hit = parseReportOutput(text);
    assert.ok(hit);
    assert.equal(hit!.filename, 'include/contenido/00-1-dedicatoria.tex');
    assert.equal(hit!.linenumber, 2);
    assert.equal(hit!.tolerance, 11);
  });

  it('returns undefined when no match line is present', () => {
    assert.equal(parseReportOutput('invalid synctex log file'), undefined);
  });

  it('detects ConTeXt invalid synctex log errors', () => {
    const text = readFixture('report-invalid-tex-path.txt');
    assert.equal(isInvalidSynctexLogMessage(text), true);
  });

  it('unquoteSynctexValue strips matching quotes', () => {
    assert.equal(unquoteSynctexValue("'foo/bar.tex'"), 'foo/bar.tex');
    assert.equal(unquoteSynctexValue('"foo.tex"'), 'foo.tex');
    assert.equal(unquoteSynctexValue('foo.tex'), 'foo.tex');
  });
});

describe('mtxSynctex empty report UX', () => {
  it('treats blank mtx stdout/stderr as empty (image / no-box click)', () => {
    assert.equal(isEmptyReportOutput('', ''), true);
    assert.equal(isEmptyReportOutput('\n', '  '), true);
  });

  it('does not treat invalid-log messages as empty', () => {
    const text = readFixture('report-invalid-tex-path.txt');
    assert.equal(isEmptyReportOutput(text, ''), false);
  });

  it('does not treat a successful console hit as empty', () => {
    const text = readFixture('report-console.txt');
    assert.equal(isEmptyReportOutput(text, ''), false);
  });

  it('exposes a short user-facing empty message distinct from coarse-float', () => {
    assert.match(EMPTY_BACKWARD_USER_MESSAGE, /images/i);
    assert.match(EMPTY_BACKWARD_USER_MESSAGE, /graphics/i);
    assert.ok(!EMPTY_BACKWARD_USER_MESSAGE.includes('argv='));
    assert.match(COARSE_FLOAT_LINE_USER_MESSAGE, /float|caption/i);
    assert.match(COARSE_FLOAT_LINE_USER_MESSAGE, /No useful SyncTeX match/i);
    assert.ok(!/jumped/i.test(COARSE_FLOAT_LINE_USER_MESSAGE));
    assert.notEqual(EMPTY_BACKWARD_USER_MESSAGE, COARSE_FLOAT_LINE_USER_MESSAGE);
  });

  it('SynctexError carries empty kind for toast routing', () => {
    const err = new SynctexError('detail for Output', 'empty');
    assert.equal(err.kind, 'empty');
    assert.equal(err.message, 'detail for Output');
  });

  it('snap tolerance is larger than the first-pass default', () => {
    assert.ok(SNAP_REPORT_TOLERANCE > DEFAULT_REPORT_TOLERANCE);
  });
});

describe('synctex page boxes (caption / float refine)', () => {
  const text = readFixture('page-with-figure.synctex.txt');

  it('parses Input + h boxes for the requested page only', () => {
    const boxes = parseSynctexPageBoxes(text, 40);
    assert.equal(boxes.length, 4);
    assert.equal(boxes[0].filename, 'chapter.tex');
    assert.equal(boxes[1].linenumber, 1);
    assert.equal(boxes[2].linenumber, 88);
    assert.equal(parseSynctexPageBoxes(text, 99).length, 0);
  });

  it('prefers a small caption box over a large line-1 float wrapper', () => {
    const boxes = parseSynctexPageBoxes(text, 40);
    // Click inside both the line-1 wrapper and the caption box at y≈520.
    const hit = nearestSynctexBox(boxes, 150, 525, 50);
    assert.ok(hit);
    assert.equal(hit!.linenumber, 88);
    assert.equal(hit!.filename, 'figures.tex');
  });

  it('returns undefined for an image-like void far from any box', () => {
    const boxes = parseSynctexPageBoxes(text, 40);
    // Center of the large wrapper but we still have that wrapper — pick a
    // point with no nearby boxes at all (top margin away from line 5 text).
    assert.equal(nearestSynctexBox(boxes, 500, 20, 10), undefined);
  });

  it('distanceToBox is 0 inside and positive outside', () => {
    const boxes = parseSynctexPageBoxes(text, 40);
    const cap = boxes.find((b) => b.linenumber === 88)!;
    assert.equal(distanceToBox(cap, 150, 525), 0);
    assert.ok(distanceToBox(cap, 150, 400) > 0);
  });

  it('flags mid-page line-1 hits as suspicious file-start', () => {
    assert.equal(isSuspiciousFileStartHit(1, 343), true);
    assert.equal(isSuspiciousFileStartHit(1, 10), false);
    assert.equal(isSuspiciousFileStartHit(88, 343), false);
  });
});

describe('forward SyncTeX edge-band refine', () => {
  const text = readFixture('page-with-header-footer.synctex.txt');
  const fixturePath = (() => {
    const candidates = [
      path.join(fixturesDir, 'page-with-header-footer.synctex.txt'),
      path.join(
        __dirname,
        '..',
        '..',
        'src',
        'test',
        'fixtures',
        'page-with-header-footer.synctex.txt',
      ),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    throw new Error('fixture not found: page-with-header-footer.synctex.txt');
  })();
  const spFixturePath = (() => {
    const candidates = [
      path.join(fixturesDir, 'page-with-header-footer-sp.synctex.txt'),
      path.join(
        __dirname,
        '..',
        '..',
        'src',
        'test',
        'fixtures',
        'page-with-header-footer-sp.synctex.txt',
      ),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    throw new Error('fixture not found: page-with-header-footer-sp.synctex.txt');
  })();

  it('picks nearest non-edge same-line box, not page middle', () => {
    const boxes = parseSynctexPageBoxes(text, 10);
    // mtx landed in the header band; nearest body box is y=100, not y=400.
    const hit = pickForwardSameLineBox(
      boxes,
      'chapter.tex',
      42,
      { x: 100, y: 20 },
      800,
    );
    assert.ok(hit);
    assert.equal(hit!.y, 100);
    assert.ok(hit!.w >= 200);
    // Must not pick the page-sized vbox (solid-fill overlay regression).
    assert.ok(hit!.h < 100);
  });

  it('matches synctex paths by basename / relative suffix', () => {
    assert.equal(synctexFilenamesMatch('chapter.tex', '/proj/chapter.tex'), true);
    assert.equal(synctexFilenamesMatch('include/chapter.tex', 'chapter.tex'), true);
    assert.equal(synctexFilenamesMatch('a.tex', 'b.tex'), false);
  });

  it('returns undefined when no box matches the line', () => {
    const boxes = parseSynctexPageBoxes(text, 10);
    assert.equal(
      pickForwardSameLineBox(boxes, 'chapter.tex', 7, { x: 100, y: 20 }, 800),
      undefined,
    );
  });

  it('exposes a small edge-band fraction for forward picks', () => {
    assert.ok(FORWARD_EDGE_BAND_FRAC > 0 && FORWARD_EDGE_BAND_FRAC < 0.2);
    assert.ok(FORWARD_MAX_BOX_PAGE_FRAC > 0 && FORWARD_MAX_BOX_PAGE_FRAC < 0.5);
  });

  it('refineForwardHit keeps synctex boxes in top-down --find space', () => {
    // Top-of-page --find hit (SyncTeX top-down: small lly).
    const edgeHit = {
      page: 10,
      llx: 72,
      lly: 15,
      urx: 192,
      ury: 30,
    };
    const refined = refineForwardHit(fixturePath, 'chapter.tex', 42, edgeHit);
    // Closest non-edge body box is synctex y≈100 (top-down).
    assert.equal(refined.diag.action, 'refined');
    assert.equal(refined.diag.hitInEdge, true);
    assert.equal(refined.diag.skipHighlight, false);
    assert.equal(refined.diag.unitScale, 1);
    assert.ok(refined.diag.sameLineCount >= 2);
    assert.equal(refined.diag.raw, edgeHit);
    assert.ok(refined.note);
    // Output stays top-down near the body box (not PDF-flipped).
    assert.ok(
      refined.result.lly > 80 && refined.result.lly < 130,
      `expected top-down body lly≈100, got ${refined.result.lly}`,
    );
    assert.ok(Math.abs(refined.result.ury - refined.result.lly) < 100);

    const midHit = {
      page: 10,
      llx: 80,
      lly: 380,
      urx: 200,
      ury: 400,
    };
    const kept = refineForwardHit(fixturePath, 'chapter.tex', 42, midHit);
    assert.equal(kept.result, midHit);
    assert.equal(kept.note, undefined);
    assert.equal(kept.diag.action, 'keep-raw');
    assert.equal(kept.diag.hitInEdge, false);
    assert.equal(kept.diag.skipHighlight, false);
    assert.equal(kept.diag.unitScale, 1);
  });

  it('refineForwardHit scales TeX sp synctex boxes to --find points', () => {
    // Same geometry as the pt fixture, stored as pt*65536 (real ConTeXt dumps).
    const edgeHit = {
      page: 10,
      llx: 72,
      lly: 15,
      urx: 192,
      ury: 30,
    };
    const refined = refineForwardHit(spFixturePath, 'chapter.tex', 42, edgeHit);
    assert.equal(refined.diag.unitScale, 65536);
    assert.equal(refined.diag.action, 'refined');
    assert.ok(
      refined.diag.pageHeight > 50 && refined.diag.pageHeight < 2000,
      `pageH should be in pt after scale, got ${refined.diag.pageHeight}`,
    );
    assert.ok(
      refined.result.lly > 80 && refined.result.lly < 200,
      `refined lly should be top-down pt near body, got ${refined.result.lly}`,
    );
    // Must not leak raw sp into the viewer box.
    assert.ok(refined.result.lly < 100_000);
    assert.ok(refined.result.llx < 1000);
  });

  it('refineForwardHit widens to nearby lines and skips unreplaced edge paints', () => {
    // Line 43 has no same-line boxes; nearby line 42 has body boxes.
    const edgeHit = {
      page: 10,
      llx: 72,
      lly: 15,
      urx: 192,
      ury: 30,
    };
    const nearby = refineForwardHit(fixturePath, 'chapter.tex', 43, edgeHit);
    assert.equal(nearby.diag.action, 'refined-nearby');
    assert.equal(nearby.diag.hitInEdge, true);
    assert.equal(nearby.diag.skipHighlight, false);
    assert.equal(nearby.diag.sameLineCount, 0);
    assert.ok(
      nearby.result.lly > 80 && nearby.result.lly < 450,
      `expected non-edge body box, got lly=${nearby.result.lly}`,
    );

    // Unknown file: no non-edge same-file boxes → skip highlight (do not paint edge).
    const unresolved = refineForwardHit(
      fixturePath,
      'missing-chapter.tex',
      42,
      edgeHit,
    );
    assert.equal(unresolved.diag.skipHighlight, true);
    assert.ok(
      unresolved.diag.action === 'no-same-line' ||
        unresolved.diag.action === 'edge-unresolved',
    );
  });

  it('pickForwardNonEdgeFallbackBox finds nearby non-edge same-file boxes', () => {
    const boxes = parseSynctexPageBoxes(text, 10);
    const hit = pickForwardNonEdgeFallbackBox(
      boxes,
      'chapter.tex',
      43,
      { x: 100, y: 20 },
      800,
    );
    assert.ok(hit);
    assert.equal(hit!.linenumber, 42);
    assert.ok(hit!.y >= 90 && hit!.y <= 420);
  });

  it('synctexUnitScaleToPt detects sp vs pt', () => {
    const ptBoxes = parseSynctexPageBoxes(text, 10);
    assert.equal(synctexUnitScaleToPt(ptBoxes), 1);
    const spText = readFixture('page-with-header-footer-sp.synctex.txt');
    const spBoxes = parseSynctexPageBoxes(spText, 10);
    assert.equal(
      synctexUnitScaleToPt(spBoxes, {
        llx: 74,
        lly: 318,
        urx: 274,
        ury: 333,
      }),
      SYNCTEX_SP_PER_PT,
    );
  });
});

describe('mtxSynctex argv construction', () => {
  const jobDir = '/home/andi/doc';
  const synctex = '/home/andi/doc/main.synctex';

  it('buildFindArgs uses jobDir cwd, relative --file, absolute synctex last', () => {
    const spec = buildFindArgs(
      synctex,
      '/home/andi/doc/include/contenido/00-1-dedicatoria.tex',
      12,
      jobDir,
    );
    assert.equal(spec.cwd, jobDir);
    assert.deepEqual(spec.args, [
      '--script',
      'synctex',
      '--find',
      '--direct',
      '--file=include/contenido/00-1-dedicatoria.tex',
      '--line=12',
      path.resolve(synctex),
    ]);
  });

  it('buildReportArgs uses --report --direct --console (not --goto / --editor)', () => {
    const spec = buildReportArgs(synctex, 7, 247.75, 347.3024535679999, jobDir, 50);
    assert.equal(spec.cwd, jobDir);
    assert.ok(spec.args.includes('--report'));
    assert.ok(spec.args.includes('--direct'));
    assert.ok(spec.args.includes('--console'));
    assert.ok(!spec.args.includes('--goto'));
    assert.ok(!spec.args.some((a) => a.startsWith('--editor')));
    assert.ok(spec.args.includes('--page=7'));
    assert.ok(spec.args.includes('--x=247.75'));
    assert.ok(spec.args.includes('--y=347.302'));
    assert.ok(spec.args.includes('--tolerance=50'));
    assert.equal(spec.args[spec.args.length - 1], path.resolve(synctex));
  });

  it('synctexSourceArg keeps paths outside jobDir absolute', () => {
    assert.equal(
      synctexSourceArg('/other/place/foo.tex', jobDir),
      '/other/place/foo.tex',
    );
  });
});
