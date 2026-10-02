import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseFindOutput,
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
  preferCentralForwardBox,
  synctexFilenamesMatch,
  isSuspiciousFileStartHit,
  distanceToBox,
  FORWARD_EDGE_BAND_FRAC,
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

describe('forward SyncTeX central-box preference', () => {
  const text = readFixture('page-with-header-footer.synctex.txt');

  it('prefers mid-page same-line box over header/footer band hits', () => {
    const boxes = parseSynctexPageBoxes(text, 10);
    const hit = preferCentralForwardBox(boxes, 'chapter.tex', 42, 800);
    assert.ok(hit);
    assert.equal(hit!.y, 400);
    assert.ok(hit!.w >= 300);
  });

  it('matches synctex paths by basename / relative suffix', () => {
    assert.equal(synctexFilenamesMatch('chapter.tex', '/proj/chapter.tex'), true);
    assert.equal(synctexFilenamesMatch('include/chapter.tex', 'chapter.tex'), true);
    assert.equal(synctexFilenamesMatch('a.tex', 'b.tex'), false);
  });

  it('returns undefined when no box matches the line', () => {
    const boxes = parseSynctexPageBoxes(text, 10);
    assert.equal(preferCentralForwardBox(boxes, 'chapter.tex', 7, 800), undefined);
  });

  it('exposes a small edge-band fraction for forward picks', () => {
    assert.ok(FORWARD_EDGE_BAND_FRAC > 0 && FORWARD_EDGE_BAND_FRAC < 0.2);
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
