/**
 * Process-tree kill for ConTeXt cancel: soft then hard, no orphans.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnContextBuild } from '../build/spawnContext';
import { killProcessTree } from '../build/killProcessTree';

async function writeScript(dir: string, name: string, body: string): Promise<string> {
  const script = path.join(dir, name);
  fs.writeFileSync(script, body);
  return script;
}

describe('killProcessTree', () => {
  it('terminates a long-running spawnContextBuild child', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kill-tree-'));
    const source = path.join(tmp, 'job.tex');
    fs.writeFileSync(source, '\\starttext hi\\stoptext\n');
    const hangJs = await writeScript(
      tmp,
      'hang.js',
      `setInterval(() => {}, 1000);`,
    );

    const { child, promise } = spawnContextBuild({
      contextPath: process.execPath,
      sourcePath: source,
      cwd: tmp,
      args: [hangJs, source],
    });

    assert.ok(child.pid != null);
    await killProcessTree(child, { graceMs: 200 });
    const result = await promise;
    assert.notEqual(result.exitCode, 0);
  });

  it('kills a POSIX process-group child of the build', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kill-group-'));
    const source = path.join(tmp, 'job.tex');
    fs.writeFileSync(source, '\\starttext hi\\stoptext\n');
    const marker = path.join(tmp, 'child-alive');
    const parentJs = await writeScript(
      tmp,
      'parent.js',
      `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
          detached: false,
          stdio: 'ignore',
        });
        fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
        setInterval(() => {}, 1000);
      `,
    );

    const { child, promise } = spawnContextBuild({
      contextPath: process.execPath,
      sourcePath: source,
      cwd: tmp,
      args: [parentJs, source],
    });

    let grandchildPid: number | undefined;
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(marker)) {
        grandchildPid = Number(fs.readFileSync(marker, 'utf8').trim());
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(grandchildPid != null && Number.isFinite(grandchildPid));

    await killProcessTree(child, { graceMs: 300 });
    await promise;

    let alive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `grandchild pid ${grandchildPid} should be dead`);
  });
});
