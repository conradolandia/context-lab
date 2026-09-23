import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeDigestif } from '../lsp/digestifProcess';

describe('probeDigestif', () => {
  it('succeeds when --version exits 0', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'digestif-probe-'));
    const bin = path.join(dir, 'digestif');
    fs.writeFileSync(bin, '#!/bin/sh\necho "Digestif 0.0-test"\nexit 0\n');
    fs.chmodSync(bin, 0o755);
    const lines: string[] = [];
    const result = await probeDigestif(bin, { ...process.env }, (l) => lines.push(l));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.version, /Digestif/);
    }
    assert.ok(lines.some((l) => l.includes('Digestif')));
  });

  it('captures stderr when --version fails', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'digestif-probe-'));
    const bin = path.join(dir, 'digestif');
    fs.writeFileSync(bin, '#!/bin/sh\necho "texlua: not found" >&2\nexit 1\n');
    fs.chmodSync(bin, 0o755);
    const result = await probeDigestif(bin, { ...process.env }, () => undefined);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.detail, /texlua/);
    }
  });
});
