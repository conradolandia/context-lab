import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLineStarts, lineAtOffset, lineTextAtOffset } from '../project/lineMap';

describe('lineMap', () => {
  it('buildLineStarts indexes empty text and single line', () => {
    assert.deepEqual(buildLineStarts(''), [0]);
    assert.deepEqual(buildLineStarts('abc'), [0]);
  });

  it('buildLineStarts records start after each newline', () => {
    assert.deepEqual(buildLineStarts('a\nb\nc'), [0, 2, 4]);
    assert.deepEqual(buildLineStarts('a\n'), [0, 2]);
  });

  it('lineAtOffset binary-searches 0-based line indices', () => {
    const starts = buildLineStarts('aa\nbbb\nc');
    assert.equal(lineAtOffset(starts, 0), 0);
    assert.equal(lineAtOffset(starts, 2), 0);
    assert.equal(lineAtOffset(starts, 3), 1);
    assert.equal(lineAtOffset(starts, 6), 1);
    assert.equal(lineAtOffset(starts, 7), 2);
  });

  it('lineTextAtOffset returns the line without trailing newline', () => {
    const text = 'one\ntwo\nthree';
    const starts = buildLineStarts(text);
    assert.equal(lineTextAtOffset(text, starts, 0), 'one');
    assert.equal(lineTextAtOffset(text, starts, 4), 'two');
    assert.equal(lineTextAtOffset(text, starts, 8), 'three');
  });
});
