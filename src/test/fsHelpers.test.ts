import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsRegularFile, readUtf8File } from '../project/fsHelpers';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-fs-'));
}

describe('fsHelpers', () => {
  it('existsRegularFile distinguishes files, dirs, and missing paths', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.tex');
    fs.writeFileSync(file, 'x');
    assert.equal(existsRegularFile(file), true);
    assert.equal(existsRegularFile(dir), false);
    assert.equal(existsRegularFile(path.join(dir, 'missing.tex')), false);
  });

  it('readUtf8File returns contents or undefined', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.tex');
    fs.writeFileSync(file, 'hello');
    assert.equal(readUtf8File(file), 'hello');
    assert.equal(readUtf8File(path.join(dir, 'missing.tex')), undefined);
  });
});
