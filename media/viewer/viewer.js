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
/** Avoid stacking setScale from rapid Shift+wheel */
let scaleInFlight = false;
/**
 * True for the whole setScale critical section (layout → syncVisiblePages →
 * scroll restore). Scroll handlers must not update currentPage; highlight /
 * ensurePageRendered must not scrollIntoView.
 */
let isZooming = false;
/**
 * Zoom-debug counters for the current setScale (posted when debugOutput is on).
 * @type {{blockedScrollPageUpdate: boolean, blockedHighlightScroll: boolean, blockedEnsureScroll: boolean}}
 */
let zoomDebugFlags = {
  blockedScrollPageUpdate: false,
  blockedHighlightScroll: false,
  blockedEnsureScroll: false,
};
/** Debounce persist of zoom/scroll for webview getState restore */
let persistStateTimer = null;
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
/**
 * Bumped on every layoutPlaceholders() so in-flight page.render() callbacks
 * from a destroyed DOM generation cannot mark the new placeholders as rendered.
 */
let layoutGeneration = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let highlightFadeTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let scrollRaf = null;
/**
 * @type {{page:number, llx:number, lly:number, urx:number, ury:number}|null}
 */
let activeHighlight = null;
let pendingHighlight = null;
/**
 * Only {@link applyHighlight} bumps this. Zoom/layout clears it so a stale
 * async paintHighlight({scroll:true}) from an earlier forward SyncTeX cannot
 * call scrollIntoView after the user zooms.
 */
let highlightScrollGen = 0;
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

/**
 * Persist scale + scroll for webview hide/restore (survives HTML refresh /
 * serializer). Keyed by cacheKey so a different PDF does not reuse offsets.
 */
function persistViewerState() {
  if (!loadedCacheKey || !pdfDoc) {
    return;
  }
  vscode.setState({
    cacheKey: loadedCacheKey,
    scale: currentScale,
    scrollTop: viewer.scrollTop,
    scrollLeft: viewer.scrollLeft,
    page: currentPage,
  });
}

function schedulePersistViewerState() {
  if (persistStateTimer) {
    clearTimeout(persistStateTimer);
  }
  persistStateTimer = setTimeout(() => {
    persistStateTimer = null;
    persistViewerState();
  }, 150);
}

/**
 * @param {string|null|undefined} cacheKey
 * @returns {{scale:number, scrollTop:number, scrollLeft:number, page:number}|null}
 */
function readPersistedViewerState(cacheKey) {
  if (!cacheKey) {
    return null;
  }
  const st = vscode.getState();
  if (!st || typeof st !== 'object' || st.cacheKey !== cacheKey) {
    return null;
  }
  const scale = Number(st.scale);
  const scrollTop = Number(st.scrollTop);
  const scrollLeft = Number(st.scrollLeft);
  const page = Number(st.page);
  if (!(scale > 0) || !Number.isFinite(scrollTop) || !Number.isFinite(scrollLeft)) {
    return null;
  }
  return {
    scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)),
    scrollTop: Math.max(0, scrollTop),
    scrollLeft: Math.max(0, scrollLeft),
    page: Number.isFinite(page) && page >= 1 ? Math.round(page) : 1,
  };
}

function updateToolbar() {
  const pages = pdfDoc?.numPages ?? 0;
  pageTotal.textContent = `/ ${pages}`;
  if (document.activeElement !== pageInput) {
    pageInput.value = String(currentPage);
  }
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
  void setScale(clamped, undefined, 'field');
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
 * mtxrun --script synctex --find returns SyncTeX top-down boxes (same space as
 * `.synctex` h/r after sp→pt). Map into PDF.js bottom-up via page.view using
 * SyncTeX pt × viewport scale (crop origin only — no pageViewH/synctexPageH
 * stretch). Reverse SyncTeX still converts clicks with pageHeight - pdfY.
 */
function mtxFindBoxToViewport(
  page,
  pageViewport,
  llx,
  lly,
  urx,
  ury,
  _synctexPageH,
  _synctexPageW,
) {
  const view = Array.isArray(page.view)
    ? page.view
    : pageViewport.viewBox || [0, 0, 612, 792];
  const xMin = view[0] ?? 0;
  const yMax = view[3] ?? 792;
  const topFromTop = Math.min(lly, ury);
  const bottomFromTop = Math.max(lly, ury);
  const pdfLlx = xMin + Math.min(llx, urx);
  const pdfUrx = xMin + Math.max(llx, urx);
  const pdfTop = yMax - topFromTop;
  const pdfBottom = yMax - bottomFromTop;
  return pdfBoxToViewport(pageViewport, pdfLlx, pdfBottom, pdfUrx, pdfTop);
}

function normalizeHighlight(msg) {
  const llx = msg.llx ?? msg.x ?? 0;
  const lly = msg.lly ?? msg.y ?? 0;
  const urx = msg.urx ?? (msg.width != null ? llx + msg.width : llx + 40);
  const ury = msg.ury ?? (msg.height != null ? lly + msg.height : lly + 12);
  return {
    page: Number(msg.page) || 1,
    llx,
    lly,
    urx,
    ury,
    synctexPageH:
      msg.synctexPageH != null && Number(msg.synctexPageH) > 0
        ? Number(msg.synctexPageH)
        : undefined,
    synctexPageW:
      msg.synctexPageW != null && Number(msg.synctexPageW) > 0
        ? Number(msg.synctexPageW)
        : undefined,
    skipHighlight: msg.skipHighlight === true,
  };
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
  layoutGeneration += 1;
  // Invalidate any in-flight "scroll to highlight" from a prior forward sync.
  highlightScrollGen = 0;
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
  const gen = layoutGeneration;
  renderingPages.add(pageNum);
  try {
    const page = await pdfDoc.getPage(pageNum);
    if (gen !== layoutGeneration || pageEls.get(pageNum) !== pageDiv) {
      // Layout/zoom/reload replaced this page node while we were awaiting.
      return;
    }
    const viewport = page.getViewport({ scale: currentScale });
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;
    pageDiv.classList.remove('placeholder');
    pageDiv.replaceChildren();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    // alpha:false canvases start black; white fill avoids a dark flash if paint
    // races ahead of pdf.js (black + yellow SyncTeX overlay reads as olive).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    pageDiv.appendChild(canvas);
    // Store viewport + page.view for delegated click conversion (--report y is top-down).
    pageDiv._viewport = viewport;
    pageDiv._pageView = page.view; // [xMin, yMin, xMax, yMax]

    await page.render({ canvasContext: ctx, viewport }).promise;
    if (gen !== layoutGeneration || pageEls.get(pageNum) !== pageDiv) {
      return;
    }
    renderedPages.add(pageNum);

    // Link hit targets only (invisible). No PDF.js AnnotationLayer.
    const links = await ensurePageLinks(page, pageNum);
    if (gen !== layoutGeneration || pageEls.get(pageNum) !== pageDiv) {
      return;
    }
    if (renderedPages.has(pageNum)) {
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
  // setScale owns sync + scroll restore while zooming; ignore scroll noise.
  if (isZooming) {
    zoomDebugFlags.blockedScrollPageUpdate = true;
    return;
  }
  if (scrollRaf) {
    return;
  }
  scrollRaf = setTimeout(() => {
    scrollRaf = null;
    if (isZooming) {
      zoomDebugFlags.blockedScrollPageUpdate = true;
      return;
    }
    void syncVisiblePages();
    // Update current page from scroll position
    if (!pdfDoc || isZooming) {
      if (isZooming) {
        zoomDebugFlags.blockedScrollPageUpdate = true;
      }
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
      schedulePersistViewerState();
    }
  }, 50);
}

/**
 * True when the live page node still has a rendered canvas (not a placeholder).
 * renderedPages alone is not enough — a stale in-flight render can poison it.
 */
function pageHasRenderedCanvas(pageNum) {
  const el = pageEls.get(pageNum);
  return !!(
    el &&
    renderedPages.has(pageNum) &&
    !el.classList.contains('placeholder') &&
    el.querySelector('canvas')
  );
}

/** Clamp SyncTeX highlight CSS box to the page viewport (no full-bleed wipe). */
function clampHighlightBox(box, pageWidth, pageHeight) {
  const left = Math.min(Math.max(0, box.left), Math.max(0, pageWidth - 1));
  const top = Math.min(Math.max(0, box.top), Math.max(0, pageHeight - 1));
  const maxW = Math.max(8, pageWidth - left);
  const maxH = Math.max(8, pageHeight - top);
  // Cap runaway coords (wrong units / page-sized vboxes) to a readable band.
  const width = Math.min(Math.max(box.width, 8), maxW, pageWidth * 0.95);
  const height = Math.min(Math.max(box.height, 8), maxH, pageHeight * 0.35);
  return { left, top, width, height };
}

function paintHighlight(opts) {
  clearHighlightDom();
  const wantScroll = opts?.scroll === true;
  // Capture gen at call time; zoom/layout zeros highlightScrollGen so stale
  // forward-sync paints cannot scroll after a scale change.
  const scrollGen = highlightScrollGen;
  const canScroll = () => {
    if (wantScroll && isZooming) {
      zoomDebugFlags.blockedHighlightScroll = true;
    }
    return (
      wantScroll &&
      !isZooming &&
      scrollGen > 0 &&
      scrollGen === highlightScrollGen
    );
  };
  const msg = activeHighlight;
  if (!msg || !pdfDoc) {
    return;
  }
  const pageDiv = pageEls.get(msg.page);
  if (!pageDiv || !pageHasRenderedCanvas(msg.page)) {
    // Stale renderedPages mark: force a real re-render of the live node.
    if (renderedPages.has(msg.page) && !pageHasRenderedCanvas(msg.page)) {
      renderedPages.delete(msg.page);
    }
    pendingHighlight = msg;
    // Never scroll while ensuring the page for a repaint; only the final
    // authorized paintHighlight may move the viewport.
    void ensurePageRendered(msg.page, { scroll: canScroll() }).then(() => {
      if (activeHighlight && activeHighlight.page === msg.page) {
        paintHighlight({ scroll: wantScroll });
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
    if (!still || !pageHasRenderedCanvas(msg.page)) {
      pendingHighlight = msg;
      if (renderedPages.has(msg.page) && !pageHasRenderedCanvas(msg.page)) {
        renderedPages.delete(msg.page);
      }
      void ensurePageRendered(msg.page, { scroll: canScroll() }).then(() => {
        if (activeHighlight && activeHighlight.page === msg.page) {
          paintHighlight({ scroll: wantScroll });
        }
      });
      return;
    }
    const viewport = page.getViewport({ scale: currentScale });
    // Re-check after await: zoom may have invalidated scroll authorization.
    const doScroll = canScroll();
    if (doScroll) {
      // One scroll per forward SyncTeX; repaints must not scroll again.
      highlightScrollGen = 0;
    }
    if (msg.skipHighlight) {
      // Edge-band `--find` with no safe replacement: scroll page only, no paint.
      if (doScroll) {
        still.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }
      const skipPayload = {
        type: 'highlight',
        page: msg.page,
        viewportLeft: 0,
        top: 0,
        w: 0,
        h: 0,
        scale: currentScale,
        llx: msg.llx,
        lly: msg.lly,
        urx: msg.urx,
        ury: msg.ury,
        skipHighlight: true,
        pageView: Array.isArray(page.view) ? [...page.view] : undefined,
        viewportHeight: viewport.height,
        synctexPageH: msg.synctexPageH,
        synctexPageW: msg.synctexPageW,
      };
      // Omit scroll diagnostics on repaint so host does not log forward-scroll.
      if (doScroll) {
        skipPayload.scrollTopBefore = viewer.scrollTop;
        skipPayload.scrollTopAfter = viewer.scrollTop;
        skipPayload.clientHeight = viewer.clientHeight;
        skipPayload.scrollHeight = viewer.scrollHeight;
        skipPayload.pageOffsetTop = still.offsetTop;
        skipPayload.pageOffsetHeight = still.offsetHeight;
      }
      vscode.postMessage(skipPayload);
      return;
    }
    const raw = mtxFindBoxToViewport(
      page,
      viewport,
      msg.llx,
      msg.lly,
      msg.urx,
      msg.ury,
      msg.synctexPageH,
      msg.synctexPageW,
    );
    const box = clampHighlightBox(raw, viewport.width, viewport.height);
    // Top-down synctex pt → CSS top (viewer scale only; no pageViewH/synctexH stretch).
    const topFromTop = Math.min(msg.lly, msg.ury);
    const simpleMtxCssTop = topFromTop * currentScale;
    const hl = document.createElement('div');
    hl.className = 'highlight';
    hl.style.left = `${box.left}px`;
    hl.style.top = `${box.top}px`;
    hl.style.width = `${box.width}px`;
    hl.style.height = `${box.height}px`;
    still.appendChild(hl);

    const scrollTopBefore = viewer.scrollTop;
    const pageOffsetTop = still.offsetTop;
    const pageOffsetHeight = still.offsetHeight;
    const canvasCenterY = box.top + box.height / 2;
    const intendedScrollTop = Math.max(
      0,
      pageOffsetTop + canvasCenterY - viewer.clientHeight / 2,
    );

    // Only a fresh forward SyncTeX (`applyHighlight`) may scroll. Re-paints
    // from virtualized render / zoom / layout must not move the viewport.
    if (doScroll) {
      hl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }

    const postHighlight = () => {
      const payload = {
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
        pageView: Array.isArray(page.view) ? [...page.view] : undefined,
        viewportHeight: viewport.height,
        synctexPageH: msg.synctexPageH,
        synctexPageW: msg.synctexPageW,
      };
      if (doScroll) {
        payload.scrollTopBefore = scrollTopBefore;
        payload.scrollTopAfter = viewer.scrollTop;
        payload.clientHeight = viewer.clientHeight;
        payload.scrollHeight = viewer.scrollHeight;
        payload.pageOffsetTop = pageOffsetTop;
        payload.pageOffsetHeight = pageOffsetHeight;
        payload.rawCanvasTop = raw.top;
        payload.clampedCanvasTop = box.top;
        payload.simpleMtxCssTop = simpleMtxCssTop;
        payload.intendedScrollTop = intendedScrollTop;
      }
      vscode.postMessage(payload);
    };

    if (doScroll) {
      // smooth scrollIntoView settles asynchronously; sample after a short delay.
      setTimeout(postHighlight, 180);
    } else {
      postHighlight();
    }

    highlightFadeTimer = setTimeout(() => {
      hl.style.opacity = '0';
    }, HIGHLIGHT_MS);
  });
}

function applyHighlight(raw) {
  activeHighlight = normalizeHighlight(raw);
  currentPage = activeHighlight.page;
  updateToolbar();
  // Authorize one scroll-to-highlight for this forward SyncTeX only.
  // Zoom owns the viewport; do not authorize or apply forward-scroll mid-zoom.
  if (isZooming) {
    zoomDebugFlags.blockedHighlightScroll = true;
    highlightScrollGen = 0;
    paintHighlight({ scroll: false });
    return;
  }
  highlightScrollGen += 1;
  const el = pageEls.get(activeHighlight.page);
  const scrollTopBeforePage = viewer.scrollTop;
  // Bring the page into view without forcing vertical center — highlight scroll
  // owns centering so page-center and highlight do not fight.
  if (el) {
    el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }
  // Diagnostic only: intended page-center scroll (not applied).
  vscode.postMessage({
    type: 'forwardSyncDiag',
    phase: 'page-center',
    page: activeHighlight.page,
    scale: currentScale,
    llx: activeHighlight.llx,
    lly: activeHighlight.lly,
    urx: activeHighlight.urx,
    ury: activeHighlight.ury,
    scrollTopBefore: scrollTopBeforePage,
    scrollTopAfter: viewer.scrollTop,
    clientHeight: viewer.clientHeight,
    scrollHeight: viewer.scrollHeight,
    pageOffsetTop: el ? el.offsetTop : undefined,
    pageOffsetHeight: el ? el.offsetHeight : undefined,
    intendedScrollTop: el
      ? Math.max(0, el.offsetTop + el.offsetHeight / 2 - viewer.clientHeight / 2)
      : undefined,
  });
  paintHighlight({ scroll: true });
}

async function ensurePageRendered(pageNum, opts) {
  if (!pdfDoc) {
    return;
  }
  const el = pageEls.get(pageNum);
  // Default: nudge into view only when intentionally seeking a page.
  // Never while zooming — restoreZoomScroll owns the viewport.
  if (el && opts?.scroll !== false) {
    if (isZooming) {
      zoomDebugFlags.blockedEnsureScroll = true;
    } else {
      el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }
  }
  await syncVisiblePages();
  if (!pageHasRenderedCanvas(pageNum)) {
    if (renderedPages.has(pageNum) && !pageHasRenderedCanvas(pageNum)) {
      renderedPages.delete(pageNum);
    }
    // Wait out an in-flight render for this page before starting another.
    const deadline = Date.now() + 5000;
    while (renderingPages.has(pageNum) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!pageHasRenderedCanvas(pageNum)) {
      await renderPageCanvas(pageNum);
    }
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
  // Webview hide/restore (or HTML refresh): same cacheKey → restore zoom/scroll.
  const persisted = preserveViewport ? null : readPersistedViewerState(cacheKey);
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
    } else if (persisted) {
      currentScale = persisted.scale;
      currentPage = Math.min(
        Math.max(1, persisted.page),
        pdfDoc.numPages || persisted.page,
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
    } else if (persisted) {
      const maxLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
      const maxTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
      viewer.scrollLeft = Math.min(maxLeft, persisted.scrollLeft);
      viewer.scrollTop = Math.min(maxTop, persisted.scrollTop);
    }
    const t0 = performance.now();
    await syncVisiblePages();
    // Re-clamp after canvases replace placeholders (heights can nudge layout).
    if (preserveViewport) {
      viewer.scrollTop = savedScrollTop;
      viewer.scrollLeft = savedScrollLeft;
    } else if (persisted) {
      const maxLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
      const maxTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
      viewer.scrollLeft = Math.min(maxLeft, persisted.scrollLeft);
      viewer.scrollTop = Math.min(maxTop, persisted.scrollTop);
    }
    const firstPageMs = Math.round(performance.now() - t0);
    const renderMs = Math.round(performance.now() - tMeasure);

    setStatus('Ready');
    updateToolbar();
    persistViewerState();
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
      restoredWebviewState: !!persisted,
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

/**
 * Map a scroll-content point to a page-local anchor BEFORE layout rebuild.
 * Absolute contentY * scaleRatio is wrong: `--page-gap` and viewer padding do
 * not scale, so the error grows with page index and snaps the viewport.
 * @param {number} contentX
 * @param {number} contentY
 * @returns {{page:number, xInPage:number, yInPage:number, pageOffsetTop:number, pageOffsetLeft:number}|null}
 */
function contentPointToPageAnchor(contentX, contentY) {
  if (!pdfDoc || pdfDoc.numPages < 1) {
    return null;
  }
  let fallback = null;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const el = pageEls.get(i);
    if (!el) {
      continue;
    }
    const top = el.offsetTop;
    const left = el.offsetLeft;
    const h = el.offsetHeight;
    const bottom = top + h;
    fallback = {
      page: i,
      xInPage: contentX - left,
      yInPage: Math.max(0, Math.min(h, contentY - top)),
      pageOffsetTop: top,
      pageOffsetLeft: left,
    };
    // Point is on this page, or in the gap above the next page → stay here.
    if (contentY < bottom || i === pdfDoc.numPages) {
      if (contentY < top) {
        fallback.yInPage = 0;
      }
      return fallback;
    }
  }
  return fallback;
}

/**
 * Intended scroll after zoom from a page-local anchor (gaps stay unscaled).
 * @param {{page:number, xInPage:number, yInPage:number}|null|undefined} pageAnchor
 * @param {number} prevScale
 * @param {number} viewX
 * @param {number} viewY
 * @returns {{scrollTop:number, scrollLeft:number, pageOffsetTop?:number}|null}
 */
function intendedZoomScroll(pageAnchor, prevScale, viewX, viewY) {
  if (!pageAnchor || !(prevScale > 0)) {
    return null;
  }
  const el = pageEls.get(pageAnchor.page);
  if (!el) {
    return null;
  }
  const ratio = currentScale / prevScale;
  const maxLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
  const maxTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
  const scrollLeft = Math.min(
    maxLeft,
    Math.max(0, el.offsetLeft + pageAnchor.xInPage * ratio - viewX),
  );
  const scrollTop = Math.min(
    maxTop,
    Math.max(0, el.offsetTop + pageAnchor.yInPage * ratio - viewY),
  );
  return { scrollTop, scrollLeft, pageOffsetTop: el.offsetTop };
}

/**
 * Restore scroll so the pre-zoom page-local point stays under the same view
 * offset. Clamps to scroll bounds. Never uses scrollIntoView.
 * @param {{page:number, xInPage:number, yInPage:number}|null|undefined} pageAnchor
 * @param {number} prevScale
 * @param {number} viewX
 * @param {number} viewY
 * @returns {{intended:number, actual:number, pageOffsetTop?:number}|null}
 */
function restoreZoomScroll(pageAnchor, prevScale, viewX, viewY) {
  const intended = intendedZoomScroll(pageAnchor, prevScale, viewX, viewY);
  if (!intended) {
    return null;
  }
  viewer.scrollLeft = intended.scrollLeft;
  viewer.scrollTop = intended.scrollTop;
  return {
    intended: intended.scrollTop,
    actual: viewer.scrollTop,
    pageOffsetTop: intended.pageOffsetTop,
  };
}

/**
 * @param {string} phase
 * @param {Record<string, unknown>} fields
 */
function postZoomDebug(phase, fields) {
  vscode.postMessage({
    type: 'zoomDebug',
    phase,
    ...fields,
  });
}

/**
 * @param {number} nextScale
 * @param {{contentX:number, contentY:number, viewX:number, viewY:number}|null|undefined} anchor
 * @param {'toolbar-in'|'toolbar-out'|'field'|'shift-wheel'|'fit-width'|'unknown'} [trigger]
 */
async function setScale(nextScale, anchor, trigger = 'unknown') {
  if (!pdfDoc) {
    return;
  }
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, nextScale));
  if (Math.abs(clamped - currentScale) < 1e-6) {
    updateToolbar();
    return;
  }
  const prevScale = currentScale;
  const pageBefore = currentPage;
  const scrollTopBefore = viewer.scrollTop;
  const scrollLeftBefore = viewer.scrollLeft;
  const scrollHeightBefore = viewer.scrollHeight;
  const clientHeightBefore = viewer.clientHeight;
  // Capture anchor before relayout. Default: viewport center so toolbar +/- /
  // Fit stay put (never scrollIntoView / page-start snap — that jumps the list).
  let viewX = viewer.clientWidth / 2;
  let viewY = viewer.clientHeight / 2;
  let contentX = viewer.scrollLeft + viewX;
  let contentY = viewer.scrollTop + viewY;
  if (anchor) {
    viewX = anchor.viewX;
    viewY = anchor.viewY;
    contentX = anchor.contentX;
    contentY = anchor.contentY;
  }
  // Page-local anchor MUST be taken before layoutPlaceholders clears the DOM.
  const pageAnchor = contentPointToPageAnchor(contentX, contentY);
  // Legacy absolute formula (for debug delta only — not applied).
  const ratio = clamped / prevScale;
  const legacyIntendedTop = contentY * ratio - viewY;

  zoomDebugFlags = {
    blockedScrollPageUpdate: false,
    blockedHighlightScroll: false,
    blockedEnsureScroll: false,
  };

  postZoomDebug('before-layout', {
    trigger,
    scaleBefore: prevScale,
    scaleAfter: clamped,
    scrollTop: scrollTopBefore,
    scrollLeft: scrollLeftBefore,
    scrollHeight: scrollHeightBefore,
    clientHeight: clientHeightBefore,
    currentPage: pageBefore,
    contentX,
    contentY,
    viewX,
    viewY,
    pageAnchor: pageAnchor
      ? {
          page: pageAnchor.page,
          xInPage: pageAnchor.xInPage,
          yInPage: pageAnchor.yInPage,
          pageOffsetTop: pageAnchor.pageOffsetTop,
        }
      : null,
    legacyIntendedTop,
  });

  currentScale = clamped;
  updateToolbar();
  setStatus('Zooming…');
  const t0 = performance.now();
  // Guard the whole layout + sync + restore window against scroll side effects.
  isZooming = true;
  // Drop any pending scroll-driven sync that would race restoreZoomScroll.
  if (scrollRaf) {
    clearTimeout(scrollRaf);
    scrollRaf = null;
  }
  // Drop forward-sync scroll authorization before layout (also cleared inside
  // layoutPlaceholders). Zoom keeps restoreZoomScroll only — never highlight scroll.
  highlightScrollGen = 0;
  /** @type {{intended:number, actual:number, pageOffsetTop?:number}|null} */
  let restoreAfterLayout = null;
  /** @type {{intended:number, actual:number, pageOffsetTop?:number}|null} */
  let restoreAfterSync = null;
  try {
    layoutPlaceholders();
    // Same turn as layout: apply scroll before paint so the list does not flash
    // at scrollTop 0 after innerHTML clear. Anchor = page-local point.
    restoreAfterLayout = restoreZoomScroll(pageAnchor, prevScale, viewX, viewY);
    const pageElAfter = pageEls.get(pageBefore);
    postZoomDebug('after-layout', {
      trigger,
      scaleBefore: prevScale,
      scaleAfter: currentScale,
      scrollTop: viewer.scrollTop,
      scrollLeft: viewer.scrollLeft,
      scrollHeight: viewer.scrollHeight,
      clientHeight: viewer.clientHeight,
      currentPage: currentPage,
      pageOffsetTop: pageElAfter ? pageElAfter.offsetTop : undefined,
      intendedRestoreTop: restoreAfterLayout?.intended,
      actualRestoreTop: restoreAfterLayout?.actual,
      legacyIntendedTop,
      blockedScrollPageUpdate: zoomDebugFlags.blockedScrollPageUpdate,
      blockedHighlightScroll: zoomDebugFlags.blockedHighlightScroll,
      blockedEnsureScroll: zoomDebugFlags.blockedEnsureScroll,
    });
    await syncVisiblePages();
    // Re-clamp after canvases replace placeholders (heights can nudge layout).
    restoreAfterSync = restoreZoomScroll(pageAnchor, prevScale, viewX, viewY);
  } finally {
    isZooming = false;
  }
  const renderMs = Math.round(performance.now() - t0);
  setStatus('Ready');
  persistViewerState();
  const pageElFinal = pageEls.get(currentPage);
  postZoomDebug('after-sync', {
    trigger,
    scaleBefore: prevScale,
    scaleAfter: currentScale,
    scrollTop: viewer.scrollTop,
    scrollLeft: viewer.scrollLeft,
    scrollHeight: viewer.scrollHeight,
    clientHeight: viewer.clientHeight,
    currentPage,
    pageBefore,
    pageOffsetTop: pageElFinal ? pageElFinal.offsetTop : undefined,
    intendedRestoreTop: restoreAfterSync?.intended,
    actualRestoreTop: restoreAfterSync?.actual,
    legacyIntendedTop,
    legacyDelta:
      restoreAfterSync != null
        ? restoreAfterSync.intended - legacyIntendedTop
        : undefined,
    blockedScrollPageUpdate: zoomDebugFlags.blockedScrollPageUpdate,
    blockedHighlightScroll: zoomDebugFlags.blockedHighlightScroll,
    blockedEnsureScroll: zoomDebugFlags.blockedEnsureScroll,
    renderMs,
  });
  // Zoom must NOT re-getDocument; log render only.
  vscode.postMessage({
    type: 'loaded',
    pages: pdfDoc.numPages,
    renderMs,
    virtual: true,
    reused: true,
  });
  if (activeHighlight) {
    // Repaint only — must not scroll (highlightScrollGen already 0).
    paintHighlight({ scroll: false });
  }
}

async function fitWidth() {
  if (!pdfDoc) {
    return;
  }
  const baseW = pageWidths[currentPage - 1] || pageWidths[0] || 612;
  const available = Math.max(40, viewer.clientWidth - 24);
  await setScale(available / baseW, undefined, 'fit-width');
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
  void setScale(currentScale + SCALE_STEP, undefined, 'toolbar-in');
});
btnZoomOut.addEventListener('click', () => {
  void setScale(currentScale - SCALE_STEP, undefined, 'toolbar-out');
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

/**
 * Shift+wheel zooms with a non-passive capture listener: Chromium ignores
 * preventDefault() on passive wheel handlers, so the page list would scroll
 * under the zoom gesture. Capture runs before scroll; window covers the
 * webview root. Ctrl/Cmd+wheel is not intercepted (native scroll / platform
 * zoom). Alt+wheel is not bound. Plain wheel keeps smooth vertical scroll.
 * @param {WheelEvent} ev
 */
function onViewerWheel(ev) {
  const pathTarget = /** @type {EventTarget|null} */ (ev.target);
  const overViewer =
    pathTarget instanceof Node &&
    (pathTarget === viewer || viewer.contains(pathTarget));
  if (!overViewer) {
    return;
  }

  // Leave Ctrl/Cmd+wheel to the viewer/browser (do not capture or preventDefault).
  if (ev.ctrlKey || ev.metaKey) {
    return;
  }

  if (!ev.shiftKey) {
    return;
  }

  // Block native scroll before #viewer scrolls under the zoom gesture.
  ev.preventDefault();
  ev.stopPropagation();
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
  void setScale(
    currentScale + direction * SCALE_STEP,
    anchor,
    'shift-wheel',
  ).finally(() => {
    scaleInFlight = false;
  });
}

// passive:false is required for preventDefault on Shift+wheel; capture:true beats scroll.
window.addEventListener('wheel', onViewerWheel, { passive: false, capture: true });

viewer.addEventListener('scroll', () => {
  scheduleSyncVisible();
  if (!isZooming) {
    schedulePersistViewerState();
  }
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
