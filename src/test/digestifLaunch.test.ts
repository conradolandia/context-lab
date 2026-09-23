import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isSelfInstallWrapper,
  resolveDigestifHome,
  resolveDigestifLaunch,
  writeTexluaLuaonlyShim,
} from '../lsp/digestifLaunch';
import { preferDigestifError } from '../lsp/digestifProcess';

const WRAPPER = `#!/bin/sh
DIGESTIF_HOME="$HOME/.digestif"
DIGESTIF_REPO="https://github.com/astoff/digestif"
LUA=texlua
export LUA_PATH="$DIGESTIF_HOME/?.lua"
exec "$LUA" "$DIGESTIF_HOME/bin/digestif" "$@"
`;

const LUA_MAIN = `#!/usr/bin/env lua
require "digestif.langserver".main(arg)
`;

describe('digestifLaunch helpers', () => {
  it('detects self-install wrapper', () => {
    assert.equal(isSelfInstallWrapper(WRAPPER), true);
    assert.equal(isSelfInstallWrapper(LUA_MAIN), false);
  });

  it('resolves DIGESTIF_HOME from wrapper / default', () => {
    const home = '/tmp/fake-home';
    assert.equal(
      resolveDigestifHome({ wrapperText: WRAPPER, homedir: home }),
      path.join(home, '.digestif'),
    );
    assert.equal(
      resolveDigestifHome({ digestifHome: '/opt/digestif', homedir: home }),
      '/opt/digestif',
    );
  });

  it('prefers luametatex --luaonly for self-install wrapper', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'digestif-launch-'));
    const home = path.join(tmp, '.digestif');
    const main = path.join(home, 'bin', 'digestif');
    fs.mkdirSync(path.dirname(main), { recursive: true });
    fs.writeFileSync(main, LUA_MAIN);
    const wrapper = path.join(tmp, 'digestif');
    fs.writeFileSync(wrapper, WRAPPER);
    fs.chmodSync(wrapper, 0o755);
    const luametatex = path.join(tmp, 'luametatex');
    fs.writeFileSync(luametatex, '#!/bin/sh\n');
    fs.chmodSync(luametatex, 0o755);

    const launch = resolveDigestifLaunch({
      digestifPath: wrapper,
      luametatex,
      digestifHome: home,
      homedir: tmp,
    });
    assert.equal(launch.method, 'luametatex-luaonly');
    assert.equal(launch.command, luametatex);
    assert.deepEqual(launch.args, ['--luaonly', main]);
    assert.ok(launch.envOverrides.LUA_PATH?.includes(home));
  });

  it('writeTexluaLuaonlyShim writes --luaonly script (not bare symlink)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'texlua-shim-'));
    const luametatex = path.join(tmp, 'luametatex');
    fs.writeFileSync(luametatex, '#!/bin/sh\n');
    fs.chmodSync(luametatex, 0o755);
    const shimDir = path.join(tmp, 'shim');
    const result = writeTexluaLuaonlyShim(luametatex, shimDir);
    assert.ok(result);
    const body = fs.readFileSync(result!.shimPath, 'utf8');
    assert.match(body, /--luaonly/);
    assert.match(body, /luametatex/);
    // Must not be a symlink to luametatex
    assert.equal(fs.lstatSync(result!.shimPath).isSymbolicLink(), false);
  });
});

describe('preferDigestifError', () => {
  it('prefers DigestiF stderr over stream-destroyed', () => {
    const msg = preferDigestifError(new Error('Cannot call write after a stream was destroyed'), {
      stdout: '',
      stderr: 'Error: could not find data files\nSet DIGESTIF_DATA\n',
    });
    assert.match(msg, /data files|DIGESTIF_DATA/);
  });

  it('annotates stream-destroyed when stderr empty', () => {
    const msg = preferDigestifError(new Error('Cannot call write after a stream was destroyed'), {
      stdout: '',
      stderr: '',
    });
    assert.match(msg, /last stderr/);
  });
});
