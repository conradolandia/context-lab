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
  pdfPath: string;
  synctexPath?: string;
  generation: number;
}

/**
 * Copy a gated PDF (+ matching synctex) into an extension cache directory.
 * Returns paths to the frozen snapshot pair.
 */
export async function publishToCache(
  jobPdfPath: string,
  cacheDir: string,
  generation: number,
  options: ArtifactGateOptions = {},
): Promise<CacheSnapshot> {
  await fsp.mkdir(cacheDir, { recursive: true });
  const size = await waitForStablePdf(jobPdfPath, options);

  const cachedPdf = path.join(cacheDir, `view-${generation}.pdf`);
  await fsp.copyFile(jobPdfPath, cachedPdf);

  let cachedSynctex: string | undefined;
  const synctex = findSynctexSibling(jobPdfPath);
  if (synctex) {
    const ext = synctex.endsWith('.gz') ? '.synctex.gz' : '.synctex';
    cachedSynctex = path.join(cacheDir, `view-${generation}${ext}`);
    await fsp.copyFile(synctex, cachedSynctex);
  }

  // Re-validate header on the copy
  if (!(await hasPdfHeader(cachedPdf))) {
    throw new ArtifactGateError('Cached PDF copy failed header check');
  }

  return {
    pdfPath: cachedPdf,
    synctexPath: cachedSynctex,
    generation,
    // expose size for tests via unused param path
  };
}

/** Exported for unit tests that need gate result metadata. */
export async function gateAndCopy(
  jobPdfPath: string,
  cacheDir: string,
  generation: number,
  options?: ArtifactGateOptions,
): Promise<GateResult & CacheSnapshot> {
  const snap = await publishToCache(jobPdfPath, cacheDir, generation, options);
  const size = (await fsp.stat(snap.pdfPath)).size;
  return { ...snap, size };
}
