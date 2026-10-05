import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildProjectModel, type ProjectNode } from '../project/projectModel';
import {
  collectGraphPaths,
  resolveProjectAnchor,
} from '../project/projectAnchor';
import { scanStructure } from '../project/structureScan';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-project-'));
}

function write(dir: string, rel: string, body: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function findByKind(nodes: ProjectNode[], kind: string): ProjectNode[] {
  const out: ProjectNode[] = [];
  for (const n of nodes) {
    if (n.kind === kind) {
      out.push(n);
    }
    out.push(...findByKind(n.children, kind));
  }
  return out;
}

describe('scanStructure fileRole', () => {
  it('detects \\startproduct name', () => {
    const { fileRole } = scanStructure('\\startproduct mybook\n\\component a\n\\stopproduct\n');
    assert.equal(fileRole?.role, 'product');
    assert.equal(fileRole?.name, 'mybook');
  });

  it('detects bracket form \\startcomponent[chap]', () => {
    const { fileRole } = scanStructure('\\startcomponent[chap-1]\n\\stopcomponent\n');
    assert.equal(fileRole?.role, 'component');
    assert.equal(fileRole?.name, 'chap-1');
  });
});

describe('buildProjectModel', () => {
  it('builds a product + environment + components; dedupes repeated component', async () => {
    const dir = await tempDir();
    const env = write(dir, 'env.tex', '\\startenvironment\n\\stopenvironment\n');
    const chap = write(dir, 'chapters/intro.tex', '\\startcomponent\n\\stopcomponent\n');
    const product = write(
      dir,
      'book.tex',
      [
        '\\startproduct book',
        '\\environment env',
        '\\usepath[chapters]',
        '\\component intro',
        '\\component intro',
        '\\component[missing-chap]',
        '\\stopproduct',
        '',
      ].join('\n'),
    );

    const model = buildProjectModel({ entryFile: product, workspaceFolders: [dir] });
    assert.equal(model.roots.length, 1);
    assert.equal(model.roots[0].kind, 'product');
    const components = model.roots[0].children.filter((c) => c.kind === 'component');
    const envs = model.roots[0].children.filter((c) => c.kind === 'environment');
    const missing = model.roots[0].children.filter((c) => c.kind === 'missing');
    assert.equal(envs.length, 1);
    assert.equal(envs[0].fsPath, env);
    assert.equal(components.length, 1);
    assert.equal(components[0].fsPath, chap);
    assert.equal(components[0].mentionCount, 2);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].label, 'missing-chap');
    assert.ok(model.unresolvedCount >= 1);
    // usemodule / externalfigure must not appear
    assert.equal(findByKind(model.roots, 'input').length, 0);
  });

  it('does not show \\usemodule or \\externalfigure nodes', async () => {
    const dir = await tempDir();
    const product = write(
      dir,
      'book.tex',
      '\\startproduct book\n\\usemodule[chem]\n\\externalfigure[logo]\n\\component gone\n\\stopproduct\n',
    );
    const model = buildProjectModel({ entryFile: product });
    const labels = model.roots[0].children.map((c) => c.label);
    assert.ok(!labels.includes('chem'));
    assert.ok(!labels.includes('logo'));
  });

  it('respects \\usepath relative to declaring file', async () => {
    const dir = await tempDir();
    write(dir, 'lib/shared.tex', '\\startcomponent\n\\stopcomponent\n');
    const product = write(
      dir,
      'prod/book.tex',
      '\\startproduct book\n\\usepath[../lib]\n\\component shared\n\\stopproduct\n',
    );
    const model = buildProjectModel({ entryFile: product });
    const comps = model.roots[0].children.filter((c) => c.kind === 'component');
    assert.equal(comps.length, 1);
    assert.equal(comps[0].fsPath, path.join(dir, 'lib/shared.tex'));
  });

  it('project + two products: expands preferred product only', async () => {
    const dir = await tempDir();
    write(dir, 'env.tex', '\\startenvironment\n\\stopenvironment\n');
    write(dir, 'a-chap.tex', '\\startcomponent\n\\stopcomponent\n');
    write(dir, 'b-chap.tex', '\\startcomponent\n\\stopcomponent\n');
    const bookA = write(
      dir,
      'book-a.tex',
      '\\startproduct book-a\n\\project series\n\\environment env\n\\component a-chap\n\\stopproduct\n',
    );
    write(
      dir,
      'book-b.tex',
      '\\startproduct book-b\n\\project series\n\\environment env\n\\component b-chap\n\\stopproduct\n',
    );
    write(
      dir,
      'series.tex',
      '\\startproject series\n\\environment env\n\\product book-a\n\\product book-b\n\\stopproject\n',
    );

    const model = buildProjectModel({
      entryFile: bookA,
      activeFile: bookA,
      workspaceFolders: [dir],
    });
    assert.equal(model.roots[0].kind, 'project');
    const products = model.roots[0].children.filter((c) => c.kind === 'product');
    assert.equal(products.length, 2);
    const preferred = products.find((p) => p.fsPath === bookA);
    const other = products.find((p) => p.fsPath !== bookA);
    assert.ok(preferred);
    assert.ok(other);
    assert.equal(preferred!.preferExpand, true);
    assert.equal(other!.preferExpand, false);
    assert.ok(preferred!.children.some((c) => c.kind === 'component'));
    // Other product stays collapsed / not fully expanded
    assert.equal(other!.children.length, 0);
  });

  it('does not expand entry product twice via project mutual reference', async () => {
    const dir = await tempDir();
    write(dir, 'c.tex', '\\startcomponent\n\\stopcomponent\n');
    const book = write(
      dir,
      'book.tex',
      '\\startproduct book\n\\project docs\n\\component c\n\\stopproduct\n',
    );
    write(dir, 'docs.tex', '\\startproject docs\n\\product book\n\\stopproject\n');

    const model = buildProjectModel({ entryFile: book, workspaceFolders: [dir] });
    assert.equal(model.roots[0].kind, 'project');
    const products = model.roots[0].children.filter((c) => c.kind === 'product');
    assert.equal(products.length, 1);
    assert.ok(products[0].children.some((c) => c.kind === 'component'));
  });

  it('skips \\component inside environment files when collecting product children', async () => {
    const dir = await tempDir();
    write(
      dir,
      'env.tex',
      '\\startenvironment\n\\component should-not-appear\n\\environment nested-env\n\\stopenvironment\n',
    );
    write(dir, 'nested-env.tex', '\\startenvironment\n\\stopenvironment\n');
    write(dir, 'chap.tex', '\\startcomponent\n\\stopcomponent\n');
    const product = write(
      dir,
      'book.tex',
      '\\startproduct book\n\\environment env\n\\component chap\n\\stopproduct\n',
    );

    const model = buildProjectModel({ entryFile: product });
    const envNode = model.roots[0].children.find((c) => c.kind === 'environment');
    assert.ok(envNode);
    assert.ok(!envNode!.children.some((c) => c.label.includes('should-not-appear')));
    assert.ok(envNode!.children.some((c) => c.kind === 'environment'));
  });

  it('honours maxFiles budget', async () => {
    const dir = await tempDir();
    const lines = ['\\startproduct book'];
    for (let i = 0; i < 20; i++) {
      write(dir, `c${i}.tex`, '\\startcomponent\n\\stopcomponent\n');
      lines.push(`\\component c${i}`);
    }
    lines.push('\\stopproduct', '');
    const product = write(dir, 'book.tex', lines.join('\n'));
    const model = buildProjectModel({ entryFile: product, maxFiles: 5 });
    assert.equal(model.truncated, true);
    assert.ok(model.fileCount <= 5);
  });

  it('missing root file yields empty message', () => {
    const model = buildProjectModel({ entryFile: '/no/such/root.tex' });
    assert.ok(model.emptyMessage);
    assert.ok(model.emptyMessage!.includes('not found') || model.roots[0]?.kind === 'message');
  });

  it('includeInputs=false hides \\input; true shows them', async () => {
    const dir = await tempDir();
    write(dir, 'pre.tex', '% preamble\n');
    const product = write(
      dir,
      'book.tex',
      '\\startproduct book\n\\input pre\n\\stopproduct\n',
    );
    const off = buildProjectModel({ entryFile: product, includeInputs: false });
    assert.equal(off.roots[0].children.filter((c) => c.kind === 'input').length, 0);
    const on = buildProjectModel({ entryFile: product, includeInputs: true });
    assert.equal(on.roots[0].children.filter((c) => c.kind === 'input').length, 1);
  });

  it('active editor = component still returns full product tree (no re-root stub)', async () => {
    // Mirrors ConTeXt test layout: product lists components; component files
    // are plain \\startcomponent without \\product / \\project (common in the wild).
    const dir = await tempDir();
    write(dir, 'env.tex', '\\startenvironment\n\\stopenvironment\n');
    const chap1 = write(
      dir,
      'chapters/one.tex',
      '\\startcomponent one\nHello\n\\stopcomponent\n',
    );
    const chap2 = write(
      dir,
      'chapters/two.tex',
      '\\startcomponent two\nWorld\n\\stopcomponent\n',
    );
    const product = write(
      dir,
      'product.tex',
      [
        '\\startproduct demo',
        '\\environment env',
        '\\usepath[chapters]',
        '\\component one',
        '\\component two',
        '\\stopproduct',
        '',
      ].join('\n'),
    );

    const fromProduct = buildProjectModel({
      entryFile: product,
      activeFile: chap1,
      workspaceFolders: [dir],
    });
    assert.equal(fromProduct.roots[0].kind, 'product');
    const comps = fromProduct.roots[0].children.filter((c) => c.kind === 'component');
    assert.equal(comps.length, 2);
    assert.ok(comps.some((c) => c.fsPath === chap1));
    assert.ok(comps.some((c) => c.fsPath === chap2));

    const graph = collectGraphPaths(fromProduct.roots);
    const anchor = resolveProjectAnchor({
      activeFile: chap1,
      activeText: fs.readFileSync(chap1, 'utf8'),
      lastEntryFile: product,
      lastGraphPaths: graph,
      workspaceFolders: [dir],
    });
    assert.ok(anchor);
    assert.equal(anchor!.entryFile, product);
    assert.equal(anchor!.outsideGraph, false);

    // Simulate the TreeView rebuild path: entry stays the product, active is the component.
    const afterFocus = buildProjectModel({
      entryFile: anchor!.entryFile,
      activeFile: chap1,
      workspaceFolders: [dir],
    });
    assert.equal(afterFocus.roots[0].kind, 'product');
    assert.equal(
      afterFocus.roots[0].children.filter((c) => c.kind === 'component').length,
      2,
    );
  });
});

describe('resolveProjectAnchor', () => {
  it('keeps last product when active is an unrelated file', async () => {
    const dir = await tempDir();
    const chap = write(dir, 'c.tex', '\\startcomponent\n\\stopcomponent\n');
    const product = write(
      dir,
      'book.tex',
      '\\startproduct book\n\\component c\n\\stopproduct\n',
    );
    const other = write(dir, 'notes.tex', '\\starttext\nnotes\n\\stoptext\n');
    const model = buildProjectModel({ entryFile: product, workspaceFolders: [dir] });
    const graph = collectGraphPaths(model.roots);
    assert.ok(graph.has(chap));

    const anchor = resolveProjectAnchor({
      activeFile: other,
      activeText: fs.readFileSync(other, 'utf8'),
      lastEntryFile: product,
      lastGraphPaths: graph,
      workspaceFolders: [dir],
    });
    assert.ok(anchor);
    assert.equal(anchor!.entryFile, product);
    assert.equal(anchor!.outsideGraph, true);
  });

  it('prefers context.rootFile over active component', async () => {
    const dir = await tempDir();
    write(dir, 'c.tex', '\\startcomponent\n\\stopcomponent\n');
    const product = write(
      dir,
      'book.tex',
      '\\startproduct book\n\\component c\n\\stopproduct\n',
    );
    const chap = path.join(dir, 'c.tex');
    const anchor = resolveProjectAnchor({
      activeFile: chap,
      activeText: fs.readFileSync(chap, 'utf8'),
      rootFileSetting: product,
      workspaceFolders: [dir],
    });
    assert.ok(anchor);
    assert.equal(anchor!.entryFile, product);
    assert.equal(anchor!.reason, 'setting:context.rootFile');
  });

  it('resolves relative context.rootFile via shared setting helper', async () => {
    const dir = await tempDir();
    const product = write(
      dir,
      'book.tex',
      '\\startproduct book\n\\stopproduct\n',
    );
    const chap = write(dir, 'c.tex', '\\startcomponent\n\\stopcomponent\n');
    const anchor = resolveProjectAnchor({
      activeFile: chap,
      activeText: fs.readFileSync(chap, 'utf8'),
      rootFileSetting: 'book.tex',
      workspaceFolders: [dir],
    });
    assert.ok(anchor);
    assert.equal(anchor!.entryFile, product);
    assert.equal(anchor!.reason, 'setting:context.rootFile');
  });
});
