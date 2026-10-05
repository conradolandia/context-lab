import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasErrorDiagnostics, parseContextLog } from '../build/parseLog';
import { readFixture } from './helpers/fixtures';

describe('parseContextLog LMTX fixtures', () => {
  it('parses tex error on line N in file X (undefined csname)', () => {
    const text = readFixture('diagnostics', 'undef.stdout.txt');
    const diags = parseContextLog(text);
    const err = diags.find((d) => d.severity === 'error' && /Undefined/i.test(d.message));
    assert.ok(err, 'expected undefined control sequence error');
    assert.equal(err.line, 2);
    assert.match(err.file ?? '', /undef\.tex/);
  });

  it('parses missing input file', () => {
    const text = readFixture('diagnostics', 'missing-input.log.txt');
    const diags = parseContextLog(text);
    const err = diags.find((d) => /not found/i.test(d.message));
    assert.ok(err);
    assert.equal(err.severity, 'error');
    assert.match(err.file ?? '', /does-not-exist/);
  });

  it('parses overfull box as warning with file:line', () => {
    const text = readFixture('diagnostics', 'overfull.stdout.txt');
    const diags = parseContextLog(text);
    const w = diags.find((d) => /overfull/i.test(d.message));
    assert.ok(w);
    assert.equal(w.severity, 'warning');
    assert.equal(w.line, 2);
    assert.match(w.file ?? '', /overfull\.tex/);
  });

  it('parses LMTX loose hbox (underfull) as warning', () => {
    const text = readFixture('diagnostics', 'underfull.stdout.txt');
    const diags = parseContextLog(text);
    const w = diags.find((d) => /loose|underfull/i.test(d.message));
    assert.ok(w);
    assert.equal(w.severity, 'warning');
    assert.equal(w.line, 2);
  });

  it('parses missing module', () => {
    const text = [
      readFixture('diagnostics', 'missing-mod.stdout.txt'),
      readFixture('diagnostics', 'missing-mod.log.txt'),
    ].join('\n');
    const diags = parseContextLog(text);
    const err = diags.find((d) => /module/i.test(d.message) && /not found/i.test(d.message));
    assert.ok(err);
    assert.equal(err.severity, 'error');
  });

  it('clean compile produces zero error diagnostics', () => {
    const text = readFixture('diagnostics', 'clean.full-stdout.txt');
    const diags = parseContextLog(text);
    assert.equal(hasErrorDiagnostics(diags), false);
    assert.equal(
      diags.filter((d) => d.severity === 'error').length,
      0,
      `unexpected errors: ${JSON.stringify(diags)}`,
    );
  });

  it('dedupes multi-pass duplicate messages', () => {
    const text = readFixture('diagnostics', 'overfull.stdout.txt');
    const diags = parseContextLog(text);
    const overfulls = diags.filter((d) => /overfull/i.test(d.message));
    assert.equal(overfulls.length, 1);
  });
});
