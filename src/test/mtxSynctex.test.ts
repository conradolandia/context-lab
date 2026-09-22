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
  isInvalidSynctexLogMessage,
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
  it('parses --direct report output', () => {
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

  it('returns undefined when no match line is present', () => {
    assert.equal(parseReportOutput('invalid synctex log file'), undefined);
  });

  it('detects ConTeXt invalid synctex log errors (including mistaken .tex paths)', () => {
    const text = readFixture('report-invalid-tex-path.txt');
    assert.equal(parseReportOutput(text), undefined);
    assert.equal(isInvalidSynctexLogMessage(text), true);
  });
});

describe('mtxSynctex argv construction', () => {
  const jobDir = '/home/andi/doc';
  const synctex = '/home/andi/.cache/view-1.synctex';

  it('buildFindArgs uses jobDir cwd, relative --file, absolute synctex last', () => {
    const spec = buildFindArgs(
      synctex,
      '/home/andi/doc/include/contenido/00-1-dedicatoria.tex',
      12,
      jobDir,
    );
    assert.equal(spec.cwd, jobDir);
    assert.equal(spec.synctexPath, path.resolve(synctex));
    assert.deepEqual(spec.args, [
      '--script',
      'synctex',
      '--find',
      '--direct',
      '--file=include/contenido/00-1-dedicatoria.tex',
      '--line=12',
      path.resolve(synctex),
    ]);
    // Synctex path is last positional — never a .tex Input path
    assert.match(spec.args[spec.args.length - 1], /\.synctex$/);
  });

  it('buildReportArgs uses --goto --direct (not --report) and jobDir cwd', () => {
    const spec = buildReportArgs(synctex, 7, 247.75, 347.3024535679999, jobDir, 50);
    assert.equal(spec.cwd, jobDir);
    assert.ok(spec.args.includes('--goto'));
    assert.ok(!spec.args.includes('--report'));
    assert.ok(spec.args.includes('--direct'));
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
