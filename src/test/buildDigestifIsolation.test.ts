/**
 * Prove ConTeXt build spawn streams output, completes, and can be re-run
 * while DigestiF-like processes are disabled, working, or crashing.
 *
 * Root cause of stuck builds: Node default spawn leaves stdin as an open pipe;
 * ConTeXt/LuaMetaTeX can block forever → building flag never clears.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnContextBuild } from '../build/spawnContext';
import { preferDigestifError } from '../lsp/digestifProcess';
import { createDigestifSpawnEnv } from '../lsp/digestifEnv';
import { BUILD_WAITS_ON_DIGESTIF } from '../lsp/digestifLifecycle';

async function writeMockContext(dir: string, body: string): Promise<string> {
  const script = path.join(dir, 'mock-context.js');
  fs.writeFileSync(script, body);
  return script;
}

describe('build isolation from DigestiF', () => {
  it('BUILD_WAITS_ON_DIGESTIF remains false', () => {
    assert.equal(BUILD_WAITS_ON_DIGESTIF, false);
  });

  it('stderr warnings are not treated as DigestiF start errors', () => {
    const msg = preferDigestifError(
      new Error('could not create connection to server'),
      {
        stdout: '',
        stderr:
          'warning: /home/andi/gigas/Apps/lmtx/tex/texmf/web2c/texmf.cnf:49: (kpathsea) No cnf value on line: OSFONTDIR =.\n',
      },
    );
    assert.match(msg, /could not create connection/i);
    assert.doesNotMatch(msg, /kpathsea|OSFONTDIR|texmf\.cnf/);
  });

  it('DigestiF spawn env keeps user PATH and only adds DIGESTIF_*', () => {
    const env = createDigestifSpawnEnv({
      baseEnv: {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/andi',
        TEXMFCNF: '/should/stay/if/user/set',
      },
      texmfDirs: ['/home/andi/Apps/lmtx/tex/texmf-context'],
    });
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
    assert.equal(env.DIGESTIF_TEXMF, '/home/andi/Apps/lmtx/tex/texmf-context');
    assert.equal(env.TEXLUA, undefined);
    assert.equal(env.TEXMFCNF, '/should/stay/if/user/set');
  });

  it('streams stdout and completes (DigestiF disabled / absent)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'build-stream-'));
    const source = path.join(tmp, 'job.tex');
    fs.writeFileSync(source, '\\starttext hi\\stoptext\n');
    const chunks: string[] = [];
    const contextJs = await writeMockContext(
      tmp,
      `
        process.stdout.write('line-one\\n');
        setTimeout(() => {
          process.stdout.write('line-two\\n');
          process.exit(0);
        }, 30);
      `,
    );

    const { promise } = spawnContextBuild({
      contextPath: process.execPath,
      sourcePath: source,
      cwd: tmp,
      args: [contextJs, source],
      onStdout: (t) => chunks.push(t),
    });
    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /line-one/);
    assert.match(result.stdout, /line-two/);
    assert.ok(chunks.join('').includes('line-one'));
  });

  it('completes and can be re-run when DigestiF-like process exits 1', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'build-crash-'));
    const source = path.join(tmp, 'job.tex');
    fs.writeFileSync(source, '\\starttext hi\\stoptext\n');
    const contextJs = await writeMockContext(
      tmp,
      `process.stdout.write('ok\\n'); process.exit(0);`,
    );
    const digestifJs = path.join(tmp, 'mock-digestif.js');
    fs.writeFileSync(
      digestifJs,
      `process.stderr.write('warning: texmf.cnf kpathsea\\n'); process.exit(1);`,
    );

    const digestif = spawn(process.execPath, [digestifJs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const first = await spawnContextBuild({
      contextPath: process.execPath,
      sourcePath: source,
      cwd: tmp,
      args: [contextJs, source],
    }).promise;
    assert.equal(first.exitCode, 0);

    const second = await spawnContextBuild({
      contextPath: process.execPath,
      sourcePath: source,
      cwd: tmp,
      args: [contextJs, source],
    }).promise;
    assert.equal(second.exitCode, 0);
    assert.match(second.stdout, /ok/);

    digestif.kill('SIGKILL');
  });

  it('completes and can be re-run when DigestiF-like process hangs', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'build-hang-'));
    const source = path.join(tmp, 'job.tex');
    fs.writeFileSync(source, '\\starttext hi\\stoptext\n');
    const contextJs = await writeMockContext(
      tmp,
      `process.stdout.write('build finished\\n'); process.exit(0);`,
    );
    const digestifJs = path.join(tmp, 'mock-digestif-hang.js');
    fs.writeFileSync(digestifJs, `setInterval(() => {}, 1000);`);

    const digestif = spawn(process.execPath, [digestifJs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const first = await spawnContextBuild({
      contextPath: process.execPath,
      sourcePath: source,
      cwd: tmp,
      args: [contextJs, source],
    }).promise;
    assert.equal(first.exitCode, 0);

    const second = await spawnContextBuild({
      contextPath: process.execPath,
      sourcePath: source,
      cwd: tmp,
      args: [contextJs, source],
    }).promise;
    assert.equal(second.exitCode, 0);

    digestif.kill('SIGKILL');
  });

  it('does not hang forever when a child would otherwise wait on stdin', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'build-stdin-'));
    const source = path.join(tmp, 'job.tex');
    fs.writeFileSync(source, 'x\n');
    // Child that exits only after stdin EOF — with stdin 'ignore', EOF is immediate.
    const contextJs = await writeMockContext(
      tmp,
      `
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => {
          process.stdout.write('stdin-closed\\n');
          process.exit(0);
        });
        // If stdin were an open pipe never closed, this would hang forever.
      `,
    );

    const result = await Promise.race([
      spawnContextBuild({
        contextPath: process.execPath,
        sourcePath: source,
        cwd: tmp,
        args: [contextJs],
      }).promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('build hung on stdin')), 2000);
      }),
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /stdin-closed/);
  });
});
