import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeDigestif } from '../lsp/digestifProcess';
import type { DigestifLaunch } from '../lsp/digestifLaunch';

function directLaunch(command: string): DigestifLaunch {
  return {
    command,
    args: [],
    envOverrides: {},
    method: 'direct',
    detail: 'test',
  };
}

describe('probeDigestif', () => {
  it('succeeds when --version exits 0 and logs stderr on failure', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'digestif-probe-'));
    const okBin = path.join(dir, 'digestif-ok');
    fs.writeFileSync(okBin, '#!/bin/sh\necho "Digestif 0.0-test"\nexit 0\n');
    fs.chmodSync(okBin, 0o755);
    const lines: string[] = [];
    const ok = await probeDigestif(directLaunch(okBin), { ...process.env }, (l) => lines.push(l));
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.match(ok.version, /Digestif/);
    }

    const badBin = path.join(dir, 'digestif-bad');
    fs.writeFileSync(badBin, '#!/bin/sh\necho "could not find data files" >&2\nexit 1\n');
    fs.chmodSync(badBin, 0o755);
    const failLines: string[] = [];
    const fail = await probeDigestif(
      directLaunch(badBin),
      { ...process.env },
      (l) => failLines.push(l),
    );
    assert.equal(fail.ok, false);
    if (!fail.ok) {
      assert.match(fail.detail, /data files/);
    }
    assert.ok(failLines.some((l) => l.includes('--- last stderr ---')));
    assert.ok(failLines.some((l) => l.includes('could not find data files')));
  });
});
