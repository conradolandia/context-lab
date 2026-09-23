/**
 * Integration: DigestiF LSP initialize under LMTX bootstrap.
 * Skips when LMTX / DigestiF are not installed (exit 2 from handshake script).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function findRepoRoot(): string {
  // Tests run with cwd = repo root; also tolerate dist/test as cwd.
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '..', '..'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'scripts', 'digestif-handshake.mjs'))) {
      return c;
    }
  }
  return process.cwd();
}

describe('DigestiF LMTX bootstrap handshake', () => {
  it('answers LSP initialize via luametatex + bootstrap', () => {
    const repoRoot = findRepoRoot();
    const script = path.join(repoRoot, 'scripts', 'digestif-handshake.mjs');
    assert.ok(fs.existsSync(script), `missing ${script}`);
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, LMTX_ROOT: process.env.LMTX_ROOT || '/tmp/lmtx-install' },
      timeout: 20_000,
      cwd: repoRoot,
    });
    if (result.status === 2) {
      console.log(result.stdout || result.stderr);
      return;
    }
    assert.equal(
      result.status,
      0,
      `handshake failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stdout ?? '', /OK: DigestiF answered initialize/);
  });
});
