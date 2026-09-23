import * as http from 'node:http';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

export interface PdfRangeServerStats {
  requests: number;
  rangeRequests: number;
  fullRequests: number;
  bytesServed: number;
}

/**
 * Tiny loopback HTTP server that serves one gated PDF with Accept-Ranges.
 * Lets PDF.js fetch page-1 chunks without downloading the whole file via
 * vscode-cdn (which often lacks range support).
 */
export class PdfRangeServer {
  private server: http.Server | undefined;
  private port: number | undefined;
  private filePath: string | undefined;
  private generation = 0;
  private stats: PdfRangeServerStats = {
    requests: 0,
    rangeRequests: 0,
    fullRequests: 0,
    bytesServed: 0,
  };

  /** Absolute path currently served (after gate only). */
  public get servedPath(): string | undefined {
    return this.filePath;
  }

  public get baseUrl(): string | undefined {
    return this.port != null ? `http://127.0.0.1:${this.port}` : undefined;
  }

  /** Snapshot of request/byte counters since the last reset. */
  public getStats(): PdfRangeServerStats {
    return { ...this.stats };
  }

  public resetStats(): void {
    this.stats = {
      requests: 0,
      rangeRequests: 0,
      fullRequests: 0,
      bytesServed: 0,
    };
  }

  /**
   * Ensure the server is listening and points at `filePath`.
   * Returns the PDF URL or undefined if bind failed.
   */
  public async serve(filePath: string): Promise<string | undefined> {
    this.filePath = filePath;
    this.generation += 1;
    this.resetStats();
    if (!this.server) {
      try {
        await this.listen();
      } catch {
        this.server = undefined;
        this.port = undefined;
        return undefined;
      }
    }
    return `${this.baseUrl}/pdf?g=${this.generation}`;
  }

  public dispose(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.port = undefined;
    }
    this.filePath = undefined;
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      server.once('error', reject);
      // port 0 → ephemeral
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.server = server;
          resolve();
        } else {
          reject(new Error('PDF range server failed to bind'));
        }
      });
    });
  }

  private setCors(res: http.ServerResponse): void {
    // Webview origin is opaque/cross-origin relative to 127.0.0.1; PDF.js
    // needs these so Range responses are readable from the worker/fetch path.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Accept-Ranges, Content-Range, Content-Length',
    );
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    this.setCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';
    if (!url.startsWith('/pdf')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const filePath = this.filePath;
    if (!filePath) {
      res.writeHead(503);
      res.end('no pdf');
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404);
      res.end('missing');
      return;
    }

    const size = stat.size;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'HEAD') {
      this.stats.requests += 1;
      res.setHeader('Content-Length', String(size));
      res.writeHead(200);
      res.end();
      return;
    }

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const chunk = end - start + 1;
      this.stats.requests += 1;
      this.stats.rangeRequests += 1;
      this.stats.bytesServed += chunk;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(chunk),
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    this.stats.requests += 1;
    this.stats.fullRequests += 1;
    this.stats.bytesServed += size;
    res.setHeader('Content-Length', String(size));
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  }
}
