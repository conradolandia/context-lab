import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFindOutput, parseReportOutput } from '../synctex/mtxSynctex';
import * as fs from 'node:fs';
import * as path from 'node:path';

const fixturesDir = path.join(__dirname, 'fixtures');

function readFixture(name: string): string {
  // Prefer source fixtures (copied next to tests) or repo fixtures via relative path
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
});
