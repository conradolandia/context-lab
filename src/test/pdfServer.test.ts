import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PdfRangeServer } from '../viewer/pdfServer';

describe('PdfRangeServer', () => {
  it('serves Accept-Ranges, CORS, and 206 partial content', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-range-'));
    const pdfPath = path.join(dir, 't.pdf');
    const body = Buffer.from('%PDF-1.4\n' + 'x'.repeat(2000) + '\n%%EOF\n');
    await fsp.writeFile(pdfPath, body);

    const server = new PdfRangeServer();
    const url = await server.serve(pdfPath);
    assert.ok(url);
    assert.match(url!, /^http:\/\/127\.0\.0\.1:\d+\/pdf\?g=\d+$/);

    const head = await fetch(url!, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(head.headers.get('access-control-allow-origin'), '*');
    assert.match(
      head.headers.get('access-control-expose-headers') ?? '',
      /Accept-Ranges/i,
    );
    assert.match(
      head.headers.get('access-control-expose-headers') ?? '',
      /Content-Range/i,
    );

    const partial = await fetch(url!, {
      headers: { Range: 'bytes=0-99' },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('access-control-allow-origin'), '*');
    const buf = Buffer.from(await partial.arrayBuffer());
    assert.equal(buf.length, 100);
    assert.equal(buf.subarray(0, 5).toString('utf8'), '%PDF-');

    const stats = server.getStats();
    assert.ok(stats.requests >= 2);
    assert.equal(stats.rangeRequests, 1);
    assert.equal(stats.bytesServed, 100);

    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
