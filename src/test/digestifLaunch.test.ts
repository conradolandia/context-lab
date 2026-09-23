import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isSelfInstallWrapper,
  resolveBootstrapPath,
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

  it('prefers luametatex-bootstrap for self-install wrapper', async () => {
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
    const bootstrap = path.join(tmp, 'digestif-lmtx-bootstrap.lua');
    fs.writeFileSync(bootstrap, '-- bootstrap\n');

    const launch = resolveDigestifLaunch({
      digestifPath: wrapper,
      luametatex,
      digestifHome: home,
      homedir: tmp,
      bootstrapPath: bootstrap,
    });
    assert.equal(launch.method, 'luametatex-bootstrap');
    assert.equal(launch.command, luametatex);
    assert.deepEqual(launch.args, ['--luaonly', bootstrap]);
    assert.ok(launch.envOverrides.LUA_PATH?.includes(home));
    assert.equal(launch.envOverrides.DIGESTIF_HOME, home);
    assert.equal(launch.bootstrapPath, bootstrap);
  });

  it('writeTexluaLuaonlyShim prefers bootstrap when set', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'texlua-shim-'));
    const luametatex = path.join(tmp, 'luametatex');
    fs.writeFileSync(luametatex, '#!/bin/sh\n');
    fs.chmodSync(luametatex, 0o755);
    const bootstrap = path.join(tmp, 'boot.lua');
    fs.writeFileSync(bootstrap, '-- boot\n');
    const shimDir = path.join(tmp, 'shim');
    const result = writeTexluaLuaonlyShim(luametatex, shimDir, bootstrap);
    assert.ok(result);
    const body = fs.readFileSync(result!.shimPath, 'utf8');
    assert.match(body, /--luaonly/);
    assert.match(body, /CONTEXT_SYNCTEX_DIGESTIF_BOOTSTRAP|boot\.lua/);
    assert.equal(fs.lstatSync(result!.shimPath).isSymbolicLink(), false);
  });

  it('resolveBootstrapPath finds resources/', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ext-root-'));
    const res = path.join(tmp, 'resources');
    fs.mkdirSync(res, { recursive: true });
    const boot = path.join(res, 'digestif-lmtx-bootstrap.lua');
    fs.writeFileSync(boot, '-- x\n');
    assert.equal(resolveBootstrapPath(tmp), boot);
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
