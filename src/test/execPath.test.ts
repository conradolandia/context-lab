import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isExecutable, whichOnPath } from '../toolchain/execPath';
import { makeTempDir } from './helpers/tmpDir';

describe('execPath', () => {
  it('isExecutable accepts an executable file and rejects dirs / missing / non-exec', async () => {
    const dir = await makeTempDir('context-exec-');
    const exe = path.join(dir, 'tool');
    const plain = path.join(dir, 'plain.txt');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o755);
    fs.writeFileSync(plain, 'x');
    fs.chmodSync(plain, 0o644);

    assert.equal(isExecutable(exe), true);
    assert.equal(isExecutable(dir), false);
    assert.equal(isExecutable(plain), false);
    assert.equal(isExecutable(path.join(dir, 'missing')), false);
  });

  it('whichOnPath finds a binary on PATH and rejects unknown names', async () => {
    const dir = await makeTempDir('context-exec-');
    const name = `ctx-exec-probe-${process.pid}`;
    const exe = path.join(dir, name);
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o755);

    const prev = process.env.PATH ?? '';
    process.env.PATH = `${dir}${path.delimiter}${prev}`;
    try {
      assert.equal(whichOnPath(name), exe);
      assert.equal(whichOnPath(`no-such-bin-${process.pid}-${Date.now()}`), undefined);
    } finally {
      process.env.PATH = prev;
    }
  });
});
