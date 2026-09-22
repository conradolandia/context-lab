import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hasPdfHeader,
  waitForStablePdf,
  gateAndCopy,
  ArtifactGateError,
} from '../build/artifactGate';

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-gate-'));
}

describe('artifactGate', () => {
  it('rejects truncated / non-PDF header', async () => {
    const dir = await makeTempDir();
    const pdf = path.join(dir, 'bad.pdf');
    await fsp.writeFile(pdf, 'NOTAPDF');
    await assert.rejects(
      () => waitForStablePdf(pdf, { settleMs: 20, settleSamples: 2 }),
      (err: unknown) =>
        err instanceof ArtifactGateError && /%PDF-/.test(err.message),
    );
  });

  it('waits while size is still growing', async () => {
    const dir = await makeTempDir();
    const pdf = path.join(dir, 'growing.pdf');
    await fsp.writeFile(pdf, '%PDF-1.4\n');

    let writes = 0;
    const interval = setInterval(() => {
      writes += 1;
      fs.appendFileSync(pdf, `obj ${writes}\n`);
      if (writes >= 4) {
        clearInterval(interval);
        fs.appendFileSync(pdf, '%%EOF\n');
      }
    }, 40);

    const size = await waitForStablePdf(pdf, { settleMs: 30, settleSamples: 3 });
    clearInterval(interval);
    assert.ok(size > 0);
    assert.equal(await hasPdfHeader(pdf), true);
  });

  it('copies a valid PDF (+ synctex) into webview-cache and records jobDir', async () => {
    const dir = await makeTempDir();
    const jobPdf = path.join(dir, 'job.pdf');
    const jobSyn = path.join(dir, 'job.synctex');
    const webviewCache = path.join(dir, 'webview-cache');
    const bookkeeping = path.join(dir, 'bookkeeping');

    const body = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\nstartxref\n0\n%%EOF\n';
    await fsp.writeFile(jobPdf, body);
    await fsp.writeFile(jobSyn, 'SyncTeX Version 1\n');

    const snap = await gateAndCopy(jobPdf, webviewCache, 1, {
      settleMs: 20,
      settleSamples: 2,
      bookkeepingCacheDir: bookkeeping,
    });

    assert.ok(fs.existsSync(snap.pdfPath));
    assert.equal(path.basename(snap.pdfPath), 'current.pdf');
    assert.ok(snap.synctexPath && fs.existsSync(snap.synctexPath));
    assert.equal(await hasPdfHeader(snap.pdfPath), true);
    assert.equal(snap.generation, 1);
    assert.equal(snap.jobDir, dir);
    assert.ok(snap.size >= body.length);
    assert.notEqual(path.resolve(snap.pdfPath), path.resolve(jobPdf));
  });

  it('fails clearly when PDF is missing', async () => {
    await assert.rejects(
      () => waitForStablePdf('/tmp/does-not-exist-context-gate.pdf', { settleMs: 10 }),
      ArtifactGateError,
    );
  });
});
