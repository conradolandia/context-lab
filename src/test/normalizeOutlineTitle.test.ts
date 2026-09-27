import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOutlineSymbols,
  normalizeOutlineTitle,
} from '../lsp/normalizeOutlineTitle';

describe('normalizeOutlineTitle', () => {
  it('strips wrapping braces and collapses newlines', () => {
    assert.equal(
      normalizeOutlineTitle('{Enfermedad de\nGaucher}'),
      'Enfermedad de Gaucher',
    );
  });

  it('collapses mixed whitespace and trims', () => {
    assert.equal(
      normalizeOutlineTitle('  Title\r\n\twith   spaces  '),
      'Title with spaces',
    );
  });

  it('leaves unbraced titles intact aside from whitespace', () => {
    assert.equal(normalizeOutlineTitle('Plain title'), 'Plain title');
  });

  it('does not strip braces that are not wrapping the whole name', () => {
    assert.equal(normalizeOutlineTitle('See {note} here'), 'See {note} here');
  });

  it('handles empty and brace-only strings', () => {
    assert.equal(normalizeOutlineTitle(''), '');
    assert.equal(normalizeOutlineTitle('{}'), '');
    assert.equal(normalizeOutlineTitle('{  }'), '');
  });
});

describe('normalizeOutlineSymbols', () => {
  it('rewrites nested DocumentSymbol names in place', () => {
    const tree = [
      {
        name: '{Chapter\nOne}',
        children: [{ name: '{Sec A}', children: [{ name: '  leaf\n' }] }],
      },
    ];
    const out = normalizeOutlineSymbols(tree);
    assert.equal(out, undefined);
    assert.equal(tree[0]!.name, 'Chapter One');
    assert.equal(tree[0]!.children![0]!.name, 'Sec A');
    assert.equal(tree[0]!.children![0]!.children![0]!.name, 'leaf');
  });
});
