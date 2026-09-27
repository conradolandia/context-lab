import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStartStop } from '../folding/startStopAnalyze';

describe('analyzeStartStop', () => {
  it('folds matching start/stop pairs by name', () => {
    const text = [
      '\\starttext',
      '\\startsection[title=A]',
      'body',
      '\\stopsection',
      '\\stoptext',
      '',
    ].join('\n');
    const a = analyzeStartStop(text);
    assert.equal(a.mismatches.length, 0);
    assert.ok(a.ranges.some((r) => r.startLine === 1 && r.endLine === 3));
    assert.ok(a.ranges.some((r) => r.startLine === 0 && r.endLine === 4));
  });

  it('warns on name mismatch', () => {
    const text = ['\\startsection', 'x', '\\stopsubsection', ''].join('\n');
    const a = analyzeStartStop(text);
    assert.equal(a.mismatches.length, 1);
    assert.equal(a.mismatches[0].startName, 'section');
    assert.equal(a.mismatches[0].stopName, 'subsection');
  });

  it('skips pairs inside typing / luacode', () => {
    const text = [
      '\\starttext',
      '\\starttyping',
      '\\startsection',
      '\\stopsubsection',
      '\\stoptyping',
      '\\stoptext',
      '',
    ].join('\n');
    const a = analyzeStartStop(text);
    assert.equal(a.mismatches.length, 0);
    assert.ok(a.ranges.some((r) => r.startLine === 0 && r.endLine === 5));
  });

  it('reports unclosed start', () => {
    const text = ['\\startchapter', 'body', ''].join('\n');
    const a = analyzeStartStop(text);
    assert.equal(a.unclosed.length, 1);
    assert.equal(a.unclosed[0].name, 'chapter');
  });
});
