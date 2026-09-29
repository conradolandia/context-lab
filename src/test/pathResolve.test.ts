import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseUsePathBody, resolveIncludePath } from '../project/pathResolve';
import { scanStructure } from '../project/structureScan';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-path-'));
}

describe('pathResolve', () => {
  it('parses usepath body', () => {
    assert.deepEqual(parseUsePathBody('../chapters, figures , /abs'), [
      '../chapters',
      'figures',
      '/abs',
    ]);
  });

  it('resolves \\component name with usepath and extension', async () => {
    const dir = await tempDir();
    const main = path.join(dir, 'main.tex');
    const chapDir = path.join(dir, 'chapters');
    fs.mkdirSync(chapDir, { recursive: true });
    const chap = path.join(chapDir, 'intro.tex');
    fs.writeFileSync(chap, '\\startcomponent\n\\stopcomponent\n');
    fs.writeFileSync(main, '\\usepath[chapters]\n\\component intro\n');

    const hit = resolveIncludePath({
      fromFile: main,
      name: 'intro',
      usePaths: ['chapters'],
    });
    assert.equal(hit, chap);
  });

  it('resolves bracket form and figure extensions', async () => {
    const dir = await tempDir();
    const main = path.join(dir, 'main.tex');
    const fig = path.join(dir, 'plot.png');
    fs.writeFileSync(fig, 'fake');
    fs.writeFileSync(main, '\\externalfigure[plot]\n');
    const hit = resolveIncludePath({
      fromFile: main,
      name: 'plot',
      extensions: ['.png', '.pdf'],
    });
    assert.equal(hit, fig);
  });
  it('resolves wiki §5 product subdirectory layout', async () => {
    const dir = await tempDir();
    const project = path.join(dir, 'project_series.tex');
    const bookDir = path.join(dir, 'book-one');
    fs.mkdirSync(bookDir, { recursive: true });
    const book = path.join(bookDir, 'book-one.tex');
    fs.writeFileSync(book, '\\startproduct book-one\n\\stopproduct\n');
    fs.writeFileSync(project, '\\startproject project_series\n\\product book-one\n\\stopproject\n');
    const hit = resolveIncludePath({ fromFile: project, name: 'book-one' });
    assert.equal(hit, book);
  });
});

describe('structureScan', () => {
  it('collects usepath and include forms; skips comments and typing', () => {
    const text = [
      '\\usepath[../lib,figs]',
      '\\component[chapters/one]',
      '\\product book',
      '\\environment{env}',
      '\\input preamble',
      '\\usemodule[chem]',
      '\\externalfigure[logo]',
      '% \\component ignored',
      '\\starttyping',
      '\\component fake',
      '\\stoptyping',
      '',
    ].join('\n');
    const { usePaths, includes } = scanStructure(text);
    assert.deepEqual(usePaths, ['../lib', 'figs']);
    const kinds = includes.map((i) => i.kind);
    assert.deepEqual(kinds, [
      'component',
      'product',
      'environment',
      'input',
      'usemodule',
      'externalfigure',
    ]);
    assert.equal(includes[0].name, 'chapters/one');
    assert.ok(!includes.some((i) => i.name === 'fake'));
  });
});
