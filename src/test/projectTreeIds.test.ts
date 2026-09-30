import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildProjectModel } from '../project/projectModel';
import { collectTreeIds, treeId } from '../project/projectTreeIds';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-tree-ids-'));
}

function write(dir: string, rel: string, body: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe('projectTreeIds', () => {
  it('prefixes child ids with parent occurrence id', () => {
    const parent = {
      kind: 'product' as const,
      label: 'book',
      fsPath: '/tmp/book.tex',
      missing: false,
      mentionCount: 1,
      children: [],
      preferExpand: true,
      commandStart: 0,
    };
    const env = {
      kind: 'environment' as const,
      label: 'env_book',
      fsPath: '/tmp/env_book.tex',
      missing: false,
      mentionCount: 1,
      children: [],
      preferExpand: false,
      commandStart: 28,
    };
    const parentId = treeId(parent);
    const childId = treeId(env, parentId);
    assert.equal(parentId, 'product:/tmp/book.tex:0');
    assert.equal(
      childId,
      'product:/tmp/book.tex:0>environment:/tmp/env_book.tex:28',
    );
  });

  it('keeps unique ids when product and components both load the same env', async () => {
    const dir = await tempDir();
    const env = write(
      dir,
      'env_book.tex',
      '\\startenvironment env_book\n\\stopenvironment\n',
    );
    write(
      dir,
      'chapters/one.tex',
      '\\startcomponent one\n\\environment env_book\n\\stopcomponent\n',
    );
    write(
      dir,
      'chapters/two.tex',
      '\\startcomponent two\n\\environment env_book\n\\stopcomponent\n',
    );
    const product = write(
      dir,
      'book.tex',
      [
        '\\startproduct book',
        '\\environment env_book',
        '\\usepath[chapters]',
        '\\component one',
        '\\component two',
        '\\stopproduct',
        '',
      ].join('\n'),
    );

    const model = buildProjectModel({ entryFile: product, workspaceFolders: [dir] });
    assert.equal(model.roots.length, 1);
    assert.equal(model.roots[0].kind, 'product');

    const envNodes: string[] = [];
    const walk = (nodes: typeof model.roots, parentId?: string): void => {
      for (const n of nodes) {
        const id = treeId(n, parentId);
        if (n.kind === 'environment' && n.fsPath && path.resolve(n.fsPath) === path.resolve(env)) {
          envNodes.push(id);
        }
        walk(n.children, id);
      }
    };
    walk(model.roots);

    // Product + two components each reference env_book → three occurrences.
    assert.equal(envNodes.length, 3);
    assert.equal(new Set(envNodes).size, 3);

    const allIds = collectTreeIds(model.roots);
    assert.equal(allIds.length, new Set(allIds).size, `duplicate tree ids: ${allIds.join('\n')}`);
  });

  it('keeps unique ids for unresolved env under multiple parents', async () => {
    const dir = await tempDir();
    write(
      dir,
      'chapters/one.tex',
      '\\startcomponent one\n\\environment env_book\n\\stopcomponent\n',
    );
    const product = write(
      dir,
      'book.tex',
      [
        '\\startproduct book',
        '\\environment env_book',
        '\\usepath[chapters]',
        '\\component one',
        '\\stopproduct',
        '',
      ].join('\n'),
    );

    const model = buildProjectModel({ entryFile: product, workspaceFolders: [dir] });
    const allIds = collectTreeIds(model.roots);
    assert.equal(allIds.length, new Set(allIds).size, `duplicate tree ids: ${allIds.join('\n')}`);

    const missingEnvIds = allIds.filter((id) => id.includes('missing:missing:env_book'));
    // At least product + component both reference the unresolved env.
    assert.ok(
      missingEnvIds.length >= 2,
      `expected ≥2 missing env ids, got ${JSON.stringify(allIds)}`,
    );
    assert.equal(new Set(missingEnvIds).size, missingEnvIds.length);
  });
});
