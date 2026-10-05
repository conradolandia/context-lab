import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_OVERRIDE_WARNING,
  appendModeToCatalog,
  assembleExtraArgs,
  formatModeFlag,
  formatModesStatusText,
  normalizeModes,
  stripModeArgs,
} from '../build/buildModes';

describe('normalizeModes', () => {
  it('trims, drops empties, dedupes preserving order', () => {
    assert.deepEqual(normalizeModes(['  draft ', '', 'print', 'draft', '  ']), [
      'draft',
      'print',
    ]);
  });

  it('returns [] for null/undefined/empty', () => {
    assert.deepEqual(normalizeModes(undefined), []);
    assert.deepEqual(normalizeModes(null), []);
    assert.deepEqual(normalizeModes([]), []);
  });
});

describe('formatModeFlag', () => {
  it('joins with commas as --mode=a,b', () => {
    assert.equal(formatModeFlag(['draft', 'print']), '--mode=draft,print');
  });
});

describe('stripModeArgs', () => {
  it('removes --mode=value', () => {
    const r = stripModeArgs(['--once', '--mode=old', '--purge']);
    assert.deepEqual(r.cleaned, ['--once', '--purge']);
    assert.equal(r.hadMode, true);
  });

  it('removes bare --mode and following token', () => {
    const r = stripModeArgs(['--mode', 'old,modes', '--once']);
    assert.deepEqual(r.cleaned, ['--once']);
    assert.equal(r.hadMode, true);
  });

  it('does not consume a following flag after bare --mode', () => {
    const r = stripModeArgs(['--mode', '--once']);
    assert.deepEqual(r.cleaned, ['--once']);
    assert.equal(r.hadMode, true);
  });

  it('leaves args without --mode unchanged', () => {
    const r = stripModeArgs(['--once', '--purgeall']);
    assert.deepEqual(r.cleaned, ['--once', '--purgeall']);
    assert.equal(r.hadMode, false);
  });
});

describe('assembleExtraArgs', () => {
  it('with active modes appends --mode and keeps other args', () => {
    const r = assembleExtraArgs(['--once'], ['draft', 'print']);
    assert.deepEqual(r.args, ['--once', '--mode=draft,print']);
    assert.equal(r.warning, undefined);
  });

  it('overrides and warns when args already have --mode', () => {
    const r = assembleExtraArgs(['--mode=legacy', '--once'], ['draft']);
    assert.deepEqual(r.args, ['--once', '--mode=draft']);
    assert.equal(r.warning, MODE_OVERRIDE_WARNING);
  });

  it('overrides bare --mode + token and warns', () => {
    const r = assembleExtraArgs(['--mode', 'legacy', '--once'], ['a', 'b']);
    assert.deepEqual(r.args, ['--once', '--mode=a,b']);
    assert.equal(r.warning, MODE_OVERRIDE_WARNING);
  });

  it('with empty active modes leaves args unchanged including --mode', () => {
    const r = assembleExtraArgs(['--mode=manual', '--once'], []);
    assert.deepEqual(r.args, ['--mode=manual', '--once']);
    assert.equal(r.warning, undefined);
  });

  it('with empty active modes and empty args returns []', () => {
    const r = assembleExtraArgs([], []);
    assert.deepEqual(r.args, []);
    assert.equal(r.warning, undefined);
  });
});

describe('appendModeToCatalog', () => {
  it('appends a new mode name', () => {
    assert.deepEqual(appendModeToCatalog(['draft'], 'print'), ['draft', 'print']);
  });

  it('does not duplicate an existing name', () => {
    assert.deepEqual(appendModeToCatalog(['draft'], 'draft'), ['draft']);
  });

  it('ignores blank names', () => {
    assert.deepEqual(appendModeToCatalog(['draft'], '  '), ['draft']);
  });
});

describe('formatModesStatusText', () => {
  it('shows none when empty', () => {
    assert.equal(formatModesStatusText([]), 'Modes: (none)');
  });

  it('lists active modes', () => {
    assert.equal(formatModesStatusText(['draft', 'print']), 'Modes: draft, print');
  });
});
