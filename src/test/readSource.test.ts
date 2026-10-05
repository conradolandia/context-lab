import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openTextFromDocuments, readTexSource } from '../project/readSource';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-read-'));
}

describe('readTexSource', () => {
  it('prefers open buffer over disk', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'main.tex');
    fs.writeFileSync(file, 'disk');
    const text = readTexSource(file, {
      getOpenText: openTextFromDocuments([
        { uri: { fsPath: file }, getText: () => 'buffer' },
      ]),
    });
    assert.equal(text, 'buffer');
  });

  it('reads from disk when no open buffer', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'main.tex');
    fs.writeFileSync(file, 'from-disk');
    const text = readTexSource(file, {
      getOpenText: () => undefined,
    });
    assert.equal(text, 'from-disk');
  });

  it('returns empty string when missing', () => {
    const text = readTexSource('/no/such/file.tex', {
      getOpenText: () => undefined,
    });
    assert.equal(text, '');
  });

  it('uses injectable readFile', () => {
    const text = readTexSource('/virtual.tex', {
      getOpenText: () => undefined,
      readFile: (p) => `injected:${p}`,
    });
    assert.equal(text, 'injected:/virtual.tex');
  });
});
