import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'language-configuration.json'), 'utf8'),
);

function autoOpen(open: string): unknown {
  return config.autoClosingPairs.find(
    (p: { open: string }) => p.open === open,
  );
}

function surrounds(open: string, close: string): boolean {
  return config.surroundingPairs.some(
    (p: [string, string]) => p[0] === open && p[1] === close,
  );
}

describe('context language pairs', () => {
  it('keeps brace bracket and paren auto-close and surround', () => {
    for (const [open, close] of [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ] as const) {
      assert.ok(autoOpen(open), `autoClosingPairs missing ${open}`);
      assert.equal((autoOpen(open) as { close: string }).close, close);
      assert.ok(surrounds(open, close), `surroundingPairs missing ${open}${close}`);
    }
  });

  it('ships ASCII double and single quotes; drops TeX backtick-quote', () => {
    assert.ok(autoOpen('"'));
    assert.ok(autoOpen("'"));
    assert.ok(surrounds('"', '"'));
    assert.ok(surrounds("'", "'"));
    assert.equal(
      config.autoClosingPairs.find((p: { open: string }) => p.open === '`'),
      undefined,
    );
    assert.ok(!surrounds('`', "'"));
  });
});
