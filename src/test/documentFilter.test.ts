import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_LIKE_LANGUAGE_IDS,
  CONTEXT_SOURCE_EXTENSIONS,
  CONTEXT_SOURCE_GLOB,
  CONTEXT_SOURCE_PATH_REGEX,
  contextDocumentSelector,
  digestifDocumentSelector,
  isContextLikeDocument,
  isContextLikeLanguageId,
  isContextSourcePath,
} from '../project/documentFilter';

function doc(languageId: string, fsPath: string) {
  return { languageId, uri: { fsPath } };
}

describe('documentFilter', () => {
  it('isContextLikeLanguageId covers context, tex, and latex', () => {
    assert.equal(isContextLikeLanguageId('context'), true);
    assert.equal(isContextLikeLanguageId('tex'), true);
    assert.equal(isContextLikeLanguageId('latex'), true);
    assert.equal(isContextLikeLanguageId('plaintext'), false);
    assert.deepEqual([...CONTEXT_LIKE_LANGUAGE_IDS], ['context', 'tex', 'latex']);
  });

  it('isContextSourcePath matches known extensions only', () => {
    for (const ext of CONTEXT_SOURCE_EXTENSIONS) {
      assert.equal(isContextSourcePath(`/ws/a.${ext}`), true);
      assert.equal(isContextSourcePath(`/ws/A.${ext.toUpperCase()}`), true);
    }
    assert.equal(isContextSourcePath('/ws/a.md'), false);
    assert.equal(isContextSourcePath('/ws/a.tex.bak'), false);
    assert.equal(CONTEXT_SOURCE_PATH_REGEX.test('book.mkiv'), true);
  });

  it('isContextLikeDocument accepts language or path', () => {
    assert.equal(isContextLikeDocument(doc('context', '/ws/a.txt')), true);
    assert.equal(isContextLikeDocument(doc('latex', '/ws/a.txt')), true);
    assert.equal(isContextLikeDocument(doc('plaintext', '/ws/a.tex')), true);
    assert.equal(isContextLikeDocument(doc('plaintext', '/ws/a.mkiv')), true);
    assert.equal(isContextLikeDocument(doc('plaintext', '/ws/a.md')), false);
  });

  it('contextDocumentSelector includes languages and source glob', () => {
    assert.equal(CONTEXT_SOURCE_GLOB, '**/*.{tex,mkiv,mkxl,mkvi,mklx,mkii,ctx}');
    const filters = contextDocumentSelector as ReadonlyArray<{
      language?: string;
      pattern?: string;
    }>;
    const langs = filters.map((f) => f.language).filter(Boolean);
    assert.deepEqual(langs, ['context', 'tex', 'latex']);
    assert.ok(filters.some((f) => f.pattern === CONTEXT_SOURCE_GLOB));
  });

  it('digestifDocumentSelector is scheme+language only (no path pattern)', () => {
    const filters = digestifDocumentSelector as ReadonlyArray<{
      scheme?: string;
      language?: string;
      pattern?: string;
    }>;
    assert.equal(filters.length, 6);
    for (const f of filters) {
      assert.ok(f.scheme === 'file' || f.scheme === 'untitled');
      assert.ok(CONTEXT_LIKE_LANGUAGE_IDS.includes(f.language as (typeof CONTEXT_LIKE_LANGUAGE_IDS)[number]));
      assert.equal(f.pattern, undefined);
    }
  });
});
