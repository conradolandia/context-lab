import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface ArtifactGateOptions {
  /** Milliseconds between size samples. Default 150. */
  settleMs?: number;
  /** Number of consecutive equal-size samples required. Default 2. */
  settleSamples?: number;
}

export interface GateResult {
  pdfPath: string;
  synctexPath?: string;
  size: number;
}

export class ArtifactGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactGateError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if the file starts with a PDF header. */
export async function hasPdfHeader(filePath: string): Promise<boolean> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    if (bytesRead < 5) {
      return false;
    }
    return buf.subarray(0, 5).toString('utf8') === '%PDF-';
  } finally {
    await fh.close();
  }
}

/** Cheap trailer heuristic: look for %%EOF near the end. */
export async function hasEofMarker(filePath: string): Promise<boolean> {
  const stat = await fsp.stat(filePath);
  const readLen = Math.min(stat.size, 1024);
  if (readLen === 0) {
    return false;
  }
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, Math.max(0, stat.size - readLen));
    return buf.toString('latin1').includes('%%EOF');
  } finally {
    await fh.close();
  }
}

/**
 * Wait until the PDF exists, has non-zero stable size, and a %PDF- header.
 * Optionally checks for %%EOF near the end.
 */
export async function waitForStablePdf(
  pdfPath: string,
  options: ArtifactGateOptions = {},
): Promise<number> {
  const settleMs = options.settleMs ?? 150;
  const settleSamples = options.settleSamples ?? 2;

  if (!fs.existsSync(pdfPath)) {
    throw new ArtifactGateError(`PDF not found after build: ${pdfPath}`);
  }

  let lastSize = -1;
  let stableCount = 0;
  const maxAttempts = 40;

  for (let i = 0; i < maxAttempts; i++) {
    const stat = await fsp.stat(pdfPath);
    if (stat.size <= 0) {
      lastSize = 0;
      stableCount = 0;
      await sleep(settleMs);
      continue;
    }
    if (stat.size === lastSize) {
      stableCount += 1;
      if (stableCount >= settleSamples) {
        if (!(await hasPdfHeader(pdfPath))) {
          throw new ArtifactGateError(
            `File does not look like a PDF (missing %PDF- header): ${pdfPath}`,
          );
        }
        // Optional EOF check — warn but do not hard-fail if absent (incremental writers).
        await hasEofMarker(pdfPath);
        return stat.size;
      }
    } else {
      lastSize = stat.size;
      stableCount = 1;
    }
    await sleep(settleMs);
  }

  throw new ArtifactGateError(
    `PDF size did not settle: ${pdfPath} (last size ${lastSize})`,
  );
}

export function findSynctexSibling(pdfPath: string): string | undefined {
  const base = pdfPath.replace(/\.pdf$/i, '');
  const candidates = [`${base}.synctex`, `${base}.synctex.gz`];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

export interface CacheSnapshot {
  /** Viewer PDF under the extension webview-cache (not the live job PDF). */
  pdfPath: string;
  /**
   * Frozen synctex used for SyncTeX lookups. Prefer the job-dir sibling after
   * a gated success; also keep a cache copy path when available.
   */
  synctexPath?: string;
  /** Absolute job PDF that was gated (for diagnostics). */
  jobPdfPath: string;
  /** Directory where the job was built — mtxrun SyncTeX cwd. */
  jobDir: string;
  generation: number;
}

export interface PublishOptions extends ArtifactGateOptions {
  /**
   * Directory under the extension (in localResourceRoots) used for the PDF
   * the webview loads via asWebviewUri — avoids globalStorage vscode-cdn 401
   * and avoids shipping multi‑MB PDFs through postMessage.
   */
  webviewCacheDir: string;
  /** Optional secondary cache (e.g. globalStorage) for bookkeeping copies. */
  bookkeepingCacheDir?: string;
}

/**
 * Gate the job PDF, then copy it into the extension webview-cache for viewing.
 * Records the job-dir synctex path (absolute) for SyncTeX with cwd = jobDir.
 * Also freezes a synctex copy under bookkeepingCacheDir when provided.
 */
export async function publishToCache(
  jobPdfPath: string,
  generation: number,
  options: PublishOptions,
): Promise<CacheSnapshot> {
  const size = await waitForStablePdf(jobPdfPath, options);
  void size;

  await fsp.mkdir(options.webviewCacheDir, { recursive: true });
  if (options.bookkeepingCacheDir) {
    await fsp.mkdir(options.bookkeepingCacheDir, { recursive: true });
  }

  const viewPdf = path.join(options.webviewCacheDir, `view-${generation}.pdf`);
  // Stable alias for asWebviewUri (overwrite in place after gate)
  const currentPdf = path.join(options.webviewCacheDir, 'current.pdf');
  await fsp.copyFile(jobPdfPath, viewPdf);
  await fsp.copyFile(jobPdfPath, currentPdf);

  const jobDir = path.dirname(path.resolve(jobPdfPath));
  const jobSynctex = findSynctexSibling(jobPdfPath);

  let synctexPath: string | undefined = jobSynctex
    ? path.resolve(jobSynctex)
    : undefined;

  // Freeze a cache copy so a later rebuild cannot race SyncTeX mid-pair.
  if (jobSynctex && options.bookkeepingCacheDir) {
    const ext = jobSynctex.endsWith('.gz') ? '.synctex.gz' : '.synctex';
    const frozen = path.join(
      options.bookkeepingCacheDir,
      `view-${generation}${ext}`,
    );
    await fsp.copyFile(jobSynctex, frozen);
    // Prefer frozen absolute path for lookups; cwd remains jobDir.
    synctexPath = frozen;
  }

  if (!(await hasPdfHeader(currentPdf))) {
    throw new ArtifactGateError('Webview-cache PDF copy failed header check');
  }

  return {
    pdfPath: currentPdf,
    synctexPath,
    jobPdfPath: path.resolve(jobPdfPath),
    jobDir,
    generation,
  };
}

/** Exported for unit tests that need gate result metadata. */
export async function gateAndCopy(
  jobPdfPath: string,
  webviewCacheDir: string,
  generation: number,
  options?: ArtifactGateOptions & { bookkeepingCacheDir?: string },
): Promise<GateResult & CacheSnapshot> {
  const snap = await publishToCache(jobPdfPath, generation, {
    webviewCacheDir,
    bookkeepingCacheDir: options?.bookkeepingCacheDir,
    settleMs: options?.settleMs,
    settleSamples: options?.settleSamples,
  });
  const size = (await fsp.stat(snap.pdfPath)).size;
  return { ...snap, size };
}
