/* global vscode API injected by host */
const vscode = acquireVsCodeApi();

const statusText = document.getElementById('statusText');
const viewer = document.getElementById('viewer');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const zoomInput = document.getElementById('zoomInput');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const btnFitWidth = document.getElementById('btnFitWidth');

const SCALE_MIN = 0.5;
const SCALE_MAX = 3;
const SCALE_STEP = 0.15;
const HIGHLIGHT_MS = 4000;
const BUFFER = 1; // render visible ±1

let pdfDoc = null;
let currentScale = 1.25;
let currentPage = 1;
/** Avoid stacking setScale from rapid Ctrl/Cmd+wheel */
let scaleInFlight = false;
/** @type {number[]} base (scale=1) page heights */
let pageHeights = [];
/** @type {number[]} base (scale=1) page widths */
let pageWidths = [];
/** @type {Map<number, HTMLElement>} */
const pageEls = new Map();
/** @type {Set<number>} */
const renderedPages = new Set();
/** @type {Set<number>} */
const renderingPages = new Set();
/** @type {ReturnType<typeof setTimeout>|null} */
let highlightFadeTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let scrollRaf = null;
/**
 * @type {{page:number, llx:number, lly:number, urx:number, ury:number}|null}
 */
let activeHighlight = null;
let pendingHighlight = null;
let pdfjsPromise = null;
/** @type {Worker|null} dedicated PDF.js worker (blob URL; same-origin) */
let pdfWorker = null;
/** @type {'real'|'fake'|'unknown'} */
let workerMode = 'unknown';
let loadedCacheKey = null;
/** Prevent overlapping openDocument for the same key */
let openInFlightKey = null;
/**
 * Cached Link annotations per page (PDF-space rect + dest/url).
 * Cleared on document reload; overlays are remounted on each render/zoom.
 * @type {Map<number, Array<{rect: number[], url?: string, dest?: unknown}>>}
 */
const pageLinkCache = new Map();

function setStatus(text, building = false) {
  statusText.textContent = text;
  document.body.classList.toggle('building', building);
}

function updateToolbar() {
  const pages = pdfDoc?.numPages ?? 0;
  pageTotal.textContent = `/ ${pages}`;
  pageInput.max = String(Math.max(pages, 1));
  pageInput.value = String(currentPage);
  pageInput.disabled = pages === 0;
  btnPrev.disabled = pages === 0 || currentPage <= 1;
  btnNext.disabled = pages === 0 || currentPage >= pages;
  if (document.activeElement !== zoomInput) {
    zoomInput.value = formatZoomPercent(currentScale);
  }
  zoomInput.disabled = !pdfDoc;
  btnZoomIn.disabled = !pdfDoc || currentScale >= SCALE_MAX - 1e-9;
  btnZoomOut.disabled = !pdfDoc || currentScale <= SCALE_MIN + 1e-9;
  btnFitWidth.disabled = !pdfDoc;
}

function formatZoomPercent(scale) {
  return `${Math.round(scale * 100)}%`;
}

/**
 * Parse toolbar zoom text (`125`, `125%`). Returns scale or null.
 */
function parseZoomInput(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/%$/, '');
  if (!text) {
    return null;
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n / 100;
}

function commitZoomInput() {
  const parsed = parseZoomInput(zoomInput.value);
  if (parsed == null) {
    zoomInput.value = formatZoomPercent(currentScale);
    return;
  }
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, parsed));
  zoomInput.value = formatZoomPercent(clamped);
  void setScale(parsed);
}

/**
 * VS Code webviews serve extension resources via a service worker that
 * dedicated Workers cannot reach. Setting workerSrc to a vscode-cdn /
 * asWebviewUri URL stalls, and PDF.js silently falls back to a "fake
 * worker" (main-thread parse of the whole PDF — ~30s for 70 MB).
 *
 * Same approach as vscode-pdf-next: fetch the self-contained worker
 * bundle as text in the page context, build a blob: module Worker, and
 * hand it to PDF.js via GlobalWorkerOptions.workerPort.
 */
async function createBlobPdfWorker() {
  if (typeof Worker !== 'function') {
    return null;
  }
  const workerUrl = new URL(
    './pdfjs/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const resp = await fetch(workerUrl);
  if (!resp.ok) {
    throw new Error(`worker fetch ${resp.status} ${resp.statusText}`);
  }
  const text = await resp.text();
  const blobUrl = URL.createObjectURL(
    new Blob([text], { type: 'text/javascript' }),
  );
  return new Worker(blobUrl, { type: 'module', name: 'pdfjs-worker' });
}

function detectWorkerMode(loadingTask) {
  const port = loadingTask?._worker?.port;
  if (typeof Worker !== 'undefined' && port instanceof Worker) {
    return 'real';
  }
  return 'fake';
}

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = await import('./pdfjs/pdf.min.mjs');
      try {
        if (!pdfWorker) {
          pdfWorker = await createBlobPdfWorker();
        }
        if (pdfWorker) {
          mod.GlobalWorkerOptions.workerPort = pdfWorker;
          workerMode = 'real';
        } else {
          throw new Error('Worker API unavailable');
        }
      } catch (err) {
        console.warn(
          'PDF.js blob worker failed; falling back to workerSrc (likely fake worker)',
          err,
        );
        workerMode = 'unknown';
        mod.GlobalWorkerOptions.workerSrc = new URL(
          './pdfjs/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
      }
      return mod;
    })();
  }
  return pdfjsPromise;
}

function pdfBoxToViewport(pageViewport, llx, lly, urx, ury) {
  const [x1, y1] = pageViewport.convertToViewportPoint(llx, ury);
  const [x2, y2] = pageViewport.convertToViewportPoint(urx, lly);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/**
 * mtx-synctex --find returns y top-down (y=0 at page top). Convert to PDF
 * bottom-up using the page view box, then to CSS via PDF.js.
 */
function mtxBoxToViewport(page, pageViewport, llx, lly, urx, ury) {
  const view = page.view; // [xMin, yMin, xMax, yMax]
  const yMax = view[3];
  const topFromTop = Math.min(lly, ury);
  const bottomFromTop = Math.max(lly, ury);
  const pdfTop = yMax - topFromTop;
  const pdfBottom = yMax - bottomFromTop;
  return pdfBoxToViewport(pageViewport, llx, pdfBottom, urx, pdfTop);
}

function normalizeHighlight(msg) {
  const llx = msg.llx ?? msg.x ?? 0;
  const lly = msg.lly ?? msg.y ?? 0;
  const urx = msg.urx ?? (msg.width != null ? llx + msg.width : llx + 40);
  const ury = msg.ury ?? (msg.height != null ? lly + msg.height : lly + 12);
  return { page: Number(msg.page) || 1, llx, lly, urx, ury };
}

function clearHighlightDom() {
  document.querySelectorAll('.highlight').forEach((el) => el.remove());
  if (highlightFadeTimer) {
    clearTimeout(highlightFadeTimer);
    highlightFadeTimer = null;
  }
}

function scaledSize(pageNum) {
  const w = (pageWidths[pageNum - 1] || 612) * currentScale;
  const h = (pageHeights[pageNum - 1] || 792) * currentScale;
  return { w, h };
}

function clearPageLinkCache() {
  pageLinkCache.clear();
}

/**
 * Fetch and cache Link-subtype annotations only (no full annotation layer).
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {number} pageNum
 */
async function ensurePageLinks(page, pageNum) {
  if (pageLinkCache.has(pageNum)) {
    return pageLinkCache.get(pageNum);
  }
  const annotations = await page.getAnnotations();
  /** @type {Array<{rect: number[], url?: string, dest?: unknown}>} */
  const links = [];
  for (const ann of annotations) {
    if (ann?.subtype !== 'Link') {
      continue;
    }
    const rect = ann.rect;
    if (!Array.isArray(rect) || rect.length < 4) {
      continue;
    }
    /** @type {{rect: number[], url?: string, dest?: unknown}} */
    const entry = { rect: [rect[0], rect[1], rect[2], rect[3]] };
    if (typeof ann.url === 'string' && ann.url) {
      entry.url = ann.url;
    } else if (ann.dest != null) {
      entry.dest = ann.dest;
    } else {
      continue;
    }
    links.push(entry);
  }
  pageLinkCache.set(pageNum, links);
  return links;
}

/**
 * Invisible hit targets over link rects (cursor:pointer only).
 * @param {HTMLElement} pageDiv
 * @param {{ convertToViewportRectangle: (r: number[]) => number[] }} viewport
 * @param {Array<{rect: number[], url?: string, dest?: unknown}>} links
 */
function mountLinkOverlays(pageDiv, viewport, links) {
  for (const link of links) {
    const vr = viewport.convertToViewportRectangle(link.rect);
    const left = Math.min(vr[0], vr[2]);
    const top = Math.min(vr[1], vr[3]);
    const width = Math.abs(vr[2] - vr[0]);
    const height = Math.abs(vr[3] - vr[1]);
    if (!(width > 0.5) || !(height > 0.5)) {
      continue;
    }
    const el = document.createElement('div');
    el.className = 'pdf-link';
    el.setAttribute('role', 'link');
    el.tabIndex = 0;
    el.setAttribute(
      'aria-label',
      link.url ? `External link: ${link.url}` : 'Internal PDF link',
    );
    if (link.url) {
      el.title = link.url;
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el._pdfLink = link;
    pageDiv.appendChild(el);
  }
}

function isAllowedExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * @param {{url?: string, dest?: unknown}} link
 */
async function followPdfLink(link) {
  if (!pdfDoc) {
    return;
  }
  if (link.url) {
    if (!isAllowedExternalUrl(link.url)) {
      return;
    }
    vscode.postMessage({ type: 'openExternal', url: link.url });
    return;
  }
  if (link.dest == null) {
    return;
  }
  const resolved = await resolveDestination(link.dest);
  if (!resolved) {
    return;
  }
  await goToDestination(resolved);
}

/**
 * @param {string | unknown[]} dest
 * @returns {Promise<{pageNumber: number, explicit: unknown[]}|null>}
 */
async function resolveDestination(dest) {
  if (!pdfDoc) {
    return null;
  }
  let explicit = dest;
  if (typeof dest === 'string') {
    explicit = await pdfDoc.getDestination(dest);
  }
  if (!Array.isArray(explicit) || explicit.length === 0 || !explicit[0]) {
    return null;
  }
  try {
    const pageIndex = await pdfDoc.getPageIndex(explicit[0]);
    return { pageNumber: pageIndex + 1, explicit };
  } catch {
    return null;
  }
}

/**
 * Scroll to an internal destination using existing viewer scroll APIs.
 * @param {{pageNumber: number, explicit: unknown[]}} resolved
 */
async function goToDestination(resolved) {
  const { pageNumber, explicit } = resolved;
  currentPage = pageNumber;
  updateToolbar();
  const pageDiv = pageEls.get(pageNumber);
  if (pageDiv) {
    pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  await ensurePageRendered(pageNumber);

  const view = explicit[1];
  const viewName =
    view && typeof view === 'object' && 'name' in view
      ? /** @type {{name?: string}} */ (view).name
      : view;
  if (viewName !== 'XYZ') {
    return;
  }
  const left = explicit[2];
  const top = explicit[3];
  const el = pageEls.get(pageNumber);
  const viewport = el?._viewport;
  if (
    !el ||
    !viewport ||
    typeof left !== 'number' ||
    typeof top !== 'number' ||
    !Number.isFinite(left) ||
    !Number.isFinite(top)
  ) {
    return;
  }
  const [vx, vy] = viewport.convertToViewportPoint(left, top);
  viewer.scrollTop = Math.max(0, el.offsetTop + vy - 48);
  viewer.scrollLeft = Math.max(0, el.offsetLeft + vx - 48);
}

function layoutPlaceholders() {
  viewer.innerHTML = '';
  pageEls.clear();
  renderedPages.clear();
  renderingPages.clear();
  if (!pdfDoc) {
    return;
  }
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const { w, h } = scaledSize(i);
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page placeholder';
    pageDiv.dataset.page = String(i);
    pageDiv.style.width = `${w}px`;
    pageDiv.style.height = `${h}px`;
    frag.appendChild(pageDiv);
    pageEls.set(i, pageDiv);
  }
  viewer.appendChild(frag);
}

function visibleRange() {
  if (!pdfDoc) {
    return { from: 1, to: 1 };
  }
  const top = viewer.scrollTop;
  const bottom = top + viewer.clientHeight;
  let from = 1;
  let to = pdfDoc.numPages;
  let found = false;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const el = pageEls.get(i);
    if (!el) {
      continue;
    }
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elBottom >= top && elTop <= bottom) {
      if (!found) {
        from = i;
        found = true;
      }
      to = i;
    } else if (found && elTop > bottom) {
      break;
    }
  }
  from = Math.max(1, from - BUFFER);
  to = Math.min(pdfDoc.numPages, to + BUFFER);
  return { from, to };
}

async function renderPageCanvas(pageNum) {
  if (!pdfDoc || renderedPages.has(pageNum) || renderingPages.has(pageNum)) {
    return;
  }
  const pageDiv = pageEls.get(pageNum);
  if (!pageDiv) {
    return;
  }
  renderingPages.add(pageNum);
  try {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale });
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;
    pageDiv.classList.remove('placeholder');
    pageDiv.replaceChildren();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageDiv.appendChild(canvas);
    // Store viewport + page.view for delegated click conversion (mtx y is top-down).
    pageDiv._viewport = viewport;
    pageDiv._pageView = page.view; // [xMin, yMin, xMax, yMax]

    await page.render({ canvasContext: ctx, viewport }).promise;
    renderedPages.add(pageNum);

    // Link hit targets only (invisible). No PDF.js AnnotationLayer.
    const links = await ensurePageLinks(page, pageNum);
    if (pageEls.get(pageNum) === pageDiv && renderedPages.has(pageNum)) {
      mountLinkOverlays(pageDiv, viewport, links);
    }

    if (pendingHighlight && pendingHighlight.page === pageNum) {
      paintHighlight({ scroll: false });
    } else if (activeHighlight && activeHighlight.page === pageNum) {
      paintHighlight({ scroll: false });
    }
  } finally {
    renderingPages.delete(pageNum);
  }
}

function unrenderPage(pageNum) {
  if (!renderedPages.has(pageNum)) {
    return;
  }
  const pageDiv = pageEls.get(pageNum);
  if (!pageDiv) {
    return;
  }
  const { w, h } = scaledSize(pageNum);
  pageDiv.classList.add('placeholder');
  pageDiv.replaceChildren();
  pageDiv.style.width = `${w}px`;
  pageDiv.style.height = `${h}px`;
  pageDiv._viewport = undefined;
  renderedPages.delete(pageNum);
}

async function syncVisiblePages() {
  if (!pdfDoc) {
    return;
  }
  const { from, to } = visibleRange();
  const needed = new Set();
  for (let i = from; i <= to; i++) {
    needed.add(i);
  }
  for (const p of [...renderedPages]) {
    if (!needed.has(p)) {
      unrenderPage(p);
    }
  }
  const jobs = [];
  for (const p of needed) {
    if (!renderedPages.has(p)) {
      jobs.push(renderPageCanvas(p));
    }
  }
  await Promise.all(jobs);
}

function scheduleSyncVisible() {
  if (scrollRaf) {
    return;
  }
  scrollRaf = setTimeout(() => {
    scrollRaf = null;
    void syncVisiblePages();
    // Update current page from scroll position
    if (!pdfDoc) {
      return;
    }
    const mid = viewer.scrollTop + viewer.clientHeight / 3;
    let best = 1;
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const el = pageEls.get(i);
      if (el && el.offsetTop <= mid) {
        best = i;
      }
    }
    if (best !== currentPage) {
      currentPage = best;
      updateToolbar();
    }
  }, 50);
}

function paintHighlight(opts) {
  clearHighlightDom();
  const shouldScroll = opts?.scroll === true;
  const msg = activeHighlight;
  if (!msg || !pdfDoc) {
    return;
  }
  const pageDiv = pageEls.get(msg.page);
  if (!pageDiv || !renderedPages.has(msg.page)) {
    pendingHighlight = msg;
    void ensurePageRendered(msg.page, { scroll: shouldScroll }).then(() => {
      if (activeHighlight && activeHighlight.page === msg.page) {
        paintHighlight({ scroll: shouldScroll });
      }
    });
    return;
  }
  pendingHighlight = null;

  pdfDoc.getPage(msg.page).then((page) => {
    if (!activeHighlight || activeHighlight.page !== msg.page) {
      return;
    }
    const still = pageEls.get(msg.page);
    if (!still || !renderedPages.has(msg.page)) {
      pendingHighlight = msg;
      return;
    }
    const viewport = page.getViewport({ scale: currentScale });
    const box = mtxBoxToViewport(page, viewport, msg.llx, msg.lly, msg.urx, msg.ury);
    const hl = document.createElement('div');
    hl.className = 'highlight';
    hl.style.left = `${box.left}px`;
    hl.style.top = `${box.top}px`;
    hl.style.width = `${Math.max(box.width, 8)}px`;
    hl.style.height = `${Math.max(box.height, 8)}px`;
    still.appendChild(hl);
    // Only scroll on a fresh forward SyncTeX (`applyHighlight`). Re-paints from
    // virtualized render / zoom / layout must not fight the user's scroll.
    if (shouldScroll) {
      hl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }

    vscode.postMessage({
      type: 'highlight',
      page: msg.page,
      viewportLeft: box.left,
      top: box.top,
      w: box.width,
      h: box.height,
      scale: currentScale,
      llx: msg.llx,
      lly: msg.lly,
      urx: msg.urx,
      ury: msg.ury,
    });

    highlightFadeTimer = setTimeout(() => {
      hl.style.opacity = '0';
    }, HIGHLIGHT_MS);
  });
}

function applyHighlight(raw) {
  activeHighlight = normalizeHighlight(raw);
  currentPage = activeHighlight.page;
  updateToolbar();
  const el = pageEls.get(activeHighlight.page);
  if (el) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
  }
  paintHighlight({ scroll: true });
}

async function ensurePageRendered(pageNum, opts) {
  if (!pdfDoc) {
    return;
  }
  const el = pageEls.get(pageNum);
  // Default: nudge into view only when intentionally seeking a page.
  if (el && opts?.scroll !== false) {
    el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }
  await syncVisiblePages();
  if (!renderedPages.has(pageNum)) {
    await renderPageCanvas(pageNum);
  }
}

async function measurePages(pdf) {
  pageHeights = [];
  pageWidths = [];
  // Sample page 1 for geometry; assume uniform if later pages match common case.
  // For mixed sizes, measure a few more cheaply.
  const first = await pdf.getPage(1);
  const v1 = first.getViewport({ scale: 1 });
  for (let i = 1; i <= pdf.numPages; i++) {
    pageWidths[i - 1] = v1.width;
    pageHeights[i - 1] = v1.height;
  }
  // Spot-check last page (often same) — if different, measure odds later on demand.
  if (pdf.numPages > 1) {
    const last = await pdf.getPage(pdf.numPages);
    const vl = last.getViewport({ scale: 1 });
    if (Math.abs(vl.height - v1.height) > 1 || Math.abs(vl.width - v1.width) > 1) {
      // Mixed sizes: measure all (metadata only, no canvas) — still much cheaper than rendering.
      const jobs = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        jobs.push(
          pdf.getPage(i).then((p) => {
            const v = p.getViewport({ scale: 1 });
            pageWidths[i - 1] = v.width;
            pageHeights[i - 1] = v.height;
          }),
        );
      }
      await Promise.all(jobs);
    } else {
      pageWidths[pdf.numPages - 1] = vl.width;
      pageHeights[pdf.numPages - 1] = vl.height;
    }
  }
}

async function openDocument(source, cacheKey, useRange) {
  if (cacheKey && cacheKey === loadedCacheKey && pdfDoc) {
    setStatus('Ready');
    updateToolbar();
    vscode.postMessage({
      type: 'loaded',
      pages: pdfDoc.numPages,
      reused: true,
      virtual: true,
    });
    // Reuse must not re-scroll to a stored SyncTeX target.
    if (activeHighlight) {
      paintHighlight({ scroll: false });
    }
    return;
  }
  if (cacheKey && openInFlightKey === cacheKey) {
    return;
  }
  openInFlightKey = cacheKey || 'inflight';

  // Preserve viewport across PDF reload (build finish). Do not replay SyncTeX.
  const preserveViewport = !!pdfDoc && loadedCacheKey != null;
  const savedScale = currentScale;
  const savedScrollTop = viewer.scrollTop;
  const savedScrollLeft = viewer.scrollLeft;
  const savedPage = currentPage;
  activeHighlight = null;
  pendingHighlight = null;
  clearHighlightDom();

  setStatus('Loading PDF…');
  const tStart = performance.now();
  let bytesFetched = 0;
  try {
    const pdfjs = await loadPdfJs();
    if (pdfDoc) {
      try {
        await pdfDoc.destroy();
      } catch {
        // ignore
      }
      pdfDoc = null;
    }
    clearPageLinkCache();

    let loadingTask;
    if (source.data != null) {
      const payload =
        source.data instanceof ArrayBuffer
          ? source.data
          : source.data?.buffer
            ? source.data
            : new Uint8Array(source.data);
      bytesFetched = payload.byteLength ?? payload.length ?? 0;
      loadingTask = pdfjs.getDocument({ data: payload });
    } else {
      const opts = {
        url: source.url,
        withCredentials: false,
        disableAutoFetch: true,
        disableStream: false,
        disableRange: !useRange,
      };
      if (useRange) {
        // 1 MiB chunks — fewer round-trips on loopback than the 64 KiB default
        opts.rangeChunkSize = 65536 * 16;
      }
      loadingTask = pdfjs.getDocument(opts);
      loadingTask.onProgress = (p) => {
        if (p && typeof p.loaded === 'number') {
          bytesFetched = p.loaded;
        }
      };
    }

    pdfDoc = await loadingTask.promise;
    workerMode = detectWorkerMode(loadingTask);
    const loadMs = Math.round(performance.now() - tStart);
    loadedCacheKey = cacheKey || null;
    if (preserveViewport) {
      currentScale = savedScale;
      currentPage = Math.min(
        Math.max(1, savedPage),
        pdfDoc.numPages || savedPage,
      );
    } else {
      currentPage = 1;
    }

    const tMeasure = performance.now();
    await measurePages(pdfDoc);
    layoutPlaceholders();
    if (preserveViewport) {
      viewer.scrollTop = savedScrollTop;
      viewer.scrollLeft = savedScrollLeft;
    }
    const t0 = performance.now();
    await syncVisiblePages();
    const firstPageMs = Math.round(performance.now() - t0);
    const renderMs = Math.round(performance.now() - tMeasure);

    setStatus('Ready');
    updateToolbar();
    vscode.postMessage({
      type: 'loaded',
      pages: pdfDoc.numPages,
      loadMs,
      firstPageMs,
      renderMs,
      bytesFetched,
      worker: workerMode,
      virtual: true,
      useRange: !!useRange,
      preservedViewport: preserveViewport,
    });
  } catch (err) {
    loadedCacheKey = null;
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Load error: ${message}`);
    vscode.postMessage({ type: 'loadError', message });
  } finally {
    openInFlightKey = null;
  }
}

async function setScale(nextScale, anchor) {
  if (!pdfDoc) {
    return;
  }
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, nextScale));
  if (Math.abs(clamped - currentScale) < 1e-6) {
    updateToolbar();
    return;
  }
  const prevScale = currentScale;
  currentScale = clamped;
  updateToolbar();
  setStatus('Zooming…');
  const t0 = performance.now();
  const keepPage = currentPage;
  layoutPlaceholders();
  if (anchor && prevScale > 0) {
    const ratio = currentScale / prevScale;
    viewer.scrollLeft = Math.max(0, anchor.contentX * ratio - anchor.viewX);
    viewer.scrollTop = Math.max(0, anchor.contentY * ratio - anchor.viewY);
  } else {
    // Keep scroll position roughly by page, not pixel.
    const el = pageEls.get(keepPage);
    if (el) {
      el.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  }
  await syncVisiblePages();
  const renderMs = Math.round(performance.now() - t0);
  setStatus('Ready');
  // Zoom must NOT re-getDocument; log render only.
  vscode.postMessage({
    type: 'loaded',
    pages: pdfDoc.numPages,
    renderMs,
    virtual: true,
    reused: true,
  });
  if (activeHighlight) {
    paintHighlight({ scroll: false });
  }
}

async function fitWidth() {
  if (!pdfDoc) {
    return;
  }
  const baseW = pageWidths[currentPage - 1] || pageWidths[0] || 612;
  const available = Math.max(40, viewer.clientWidth - 24);
  await setScale(available / baseW);
}

async function goToPage(pageNum) {
  if (!pdfDoc) {
    return;
  }
  const n = Math.min(pdfDoc.numPages, Math.max(1, Math.round(pageNum)));
  currentPage = n;
  updateToolbar();
  const pageDiv = pageEls.get(n);
  if (pageDiv) {
    pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  await ensurePageRendered(n);
}

// Single delegated click — never register per-page listeners (avoids doubles).
// Ctrl/Cmd+click → SyncTeX (wins over links). Plain click → Link hit target only.
viewer.addEventListener('click', (ev) => {
  if (!pdfDoc) {
    return;
  }

  if (ev.ctrlKey || ev.metaKey) {
    const pageDiv = ev.target?.closest?.('.page');
    if (!pageDiv) {
      return;
    }
    const pageNum = Number(pageDiv.dataset.page);
    const viewport = pageDiv._viewport;
    if (!viewport || !pageNum) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const rect = pageDiv.getBoundingClientRect();
    const cssX = ev.clientX - rect.left;
    const cssY = ev.clientY - rect.top;
    const [pdfX, pdfY] = viewport.convertToPdfPoint(cssX, cssY);
    // mtx-synctex --y is top-down; PDF.js pdfY is bottom-up.
    const view = pageDiv._pageView || viewport.viewBox || [0, 0, 612, 792];
    const yMax = view[3];
    const yMin = view[1];
    const pageHeight = yMax - yMin;
    const mtxY = yMax - pdfY;
    vscode.postMessage({
      type: 'click',
      page: pageNum,
      x: pdfX,
      y: mtxY,
      pdfY,
      pageHeight,
    });
    return;
  }

  const linkEl = ev.target?.closest?.('.pdf-link');
  if (!linkEl || !linkEl._pdfLink) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  void followPdfLink(linkEl._pdfLink);
});

btnPrev.addEventListener('click', () => {
  void goToPage(currentPage - 1);
});
btnNext.addEventListener('click', () => {
  void goToPage(currentPage + 1);
});
btnZoomIn.addEventListener('click', () => {
  void setScale(currentScale + SCALE_STEP);
});
btnZoomOut.addEventListener('click', () => {
  void setScale(currentScale - SCALE_STEP);
});
btnFitWidth.addEventListener('click', () => {
  void fitWidth();
});
pageInput.addEventListener('change', () => {
  void goToPage(Number(pageInput.value) || 1);
});
pageInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    void goToPage(Number(pageInput.value) || 1);
  }
});
zoomInput.addEventListener('change', () => {
  commitZoomInput();
});
zoomInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    zoomInput.blur();
  } else if (ev.key === 'Escape') {
    zoomInput.value = formatZoomPercent(currentScale);
    zoomInput.blur();
  }
});
zoomInput.addEventListener('blur', () => {
  // change handles commits; restore display if the value never changed (invalid kept).
  if (parseZoomInput(zoomInput.value) == null) {
    zoomInput.value = formatZoomPercent(currentScale);
  }
});

// Ctrl/Cmd+wheel zooms; plain wheel keeps vertical scroll.
viewer.addEventListener(
  'wheel',
  (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) {
      return;
    }
    ev.preventDefault();
    if (!pdfDoc || scaleInFlight) {
      return;
    }
    const direction = ev.deltaY < 0 ? 1 : ev.deltaY > 0 ? -1 : 0;
    if (direction === 0) {
      return;
    }
    const rect = viewer.getBoundingClientRect();
    const viewX = ev.clientX - rect.left;
    const viewY = ev.clientY - rect.top;
    const anchor = {
      contentX: viewer.scrollLeft + viewX,
      contentY: viewer.scrollTop + viewY,
      viewX,
      viewY,
    };
    scaleInFlight = true;
    void setScale(currentScale + direction * SCALE_STEP, anchor).finally(() => {
      scaleInFlight = false;
    });
  },
  { passive: false },
);

viewer.addEventListener('scroll', () => {
  scheduleSyncVisible();
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') {
    return;
  }
  switch (msg.type) {
    case 'loadPdf':
      if (msg.data != null) {
        void openDocument({ data: msg.data }, msg.cacheKey, false);
      } else if (msg.url) {
        void openDocument({ url: msg.url }, msg.cacheKey, !!msg.useRange);
      } else {
        setStatus('Load error: missing PDF url/data');
        vscode.postMessage({
          type: 'loadError',
          message: 'Host did not send PDF url or bytes',
        });
      }
      break;
    case 'building':
      setStatus(msg.message || 'Building…', true);
      break;
    case 'idle':
      setStatus(msg.message || 'Ready', false);
      break;
    case 'forwardSync':
      applyHighlight(msg);
      break;
    case 'error':
      setStatus(msg.message || 'Error', false);
      break;
    default:
      break;
  }
});

updateToolbar();
vscode.postMessage({ type: 'ready' });
