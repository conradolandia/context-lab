import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'language-configuration.json'), 'utf8'),
);
const start = new RegExp(config.folding.markers.start);
const end = new RegExp(config.folding.markers.end);

describe('folding markers', () => {
  it('opens a region on \\start<name> and %region lines', () => {
    for (const line of [
      '\\starttext',
      '  \\startsection[title=Fórmulas]',
      '\\startluacode',
      '%region Macros',
      '% #region',
    ]) {
      assert.ok(start.test(line), line);
    }
  });

  it('ignores one-line pairs, mid-line starts, bare \\start and stop lines', () => {
    for (const line of [
      '\\startitemize \\item a \\stopitemize',
      'text \\startsection',
      '\\start \\bf x',
      '\\stopsection',
      '% a comment about regions',
    ]) {
      assert.ok(!start.test(line), line);
    }
  });

  it('closes a region on \\stop<name> and %endregion lines', () => {
    for (const line of ['\\stoptext', '    \\stopsubsection', '%endregion', '% #endregion']) {
      assert.ok(end.test(line), line);
    }
    for (const line of ['\\starttext', 'a \\stoptext', '\\stop']) {
      assert.ok(!end.test(line), line);
    }
  });
});
