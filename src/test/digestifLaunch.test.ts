import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findLuarocksDigestif, resolveDigestifLaunch } from '../lsp/digestifLaunch';
import { preferDigestifError } from '../lsp/digestifProcess';

describe('digestifLaunch helpers', () => {
  it('always launches direct for override / luarocks / path', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'digestif-direct-'));
    const main = path.join(tmp, 'digestif');
    fs.writeFileSync(main, '#!/usr/bin/env lua\n');
    fs.chmodSync(main, 0o755);

    for (const source of ['override', 'path', 'luarocks'] as const) {
      const launch = resolveDigestifLaunch({ digestifPath: main, source });
      assert.equal(launch.method, 'direct', source);
      assert.equal(launch.command, main, source);
      assert.deepEqual(launch.args, [], source);
      assert.deepEqual(launch.envOverrides, {}, source);
    }
  });

  it('findLuarocksDigestif locates ~/.luarocks/bin/digestif', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'luarocks-home-'));
    const bin = path.join(tmp, '.luarocks', 'bin', 'digestif');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    assert.equal(findLuarocksDigestif(tmp), bin);
  });
});

describe('preferDigestifError', () => {
  it('uses LanguageClient error, not DigestiF stderr', () => {
    const msg = preferDigestifError(new Error('Cannot call write after a stream was destroyed'), {
      stdout: '',
      stderr: 'warning: texmf.cnf kpathsea noise\n',
    });
    assert.match(msg, /stream was destroyed/);
    assert.doesNotMatch(msg, /kpathsea|texmf/);
  });
});
