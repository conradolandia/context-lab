/* global vscode API injected by host */
const vscode = acquireVsCodeApi();

const statusText = document.getElementById('statusText');
const viewer = document.getElementById('viewer');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const zoomLabel = document.getElementById('zoomLabel');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const btnFitWidth = document.getElementById('btnFitWidth');

const SCALE_MIN = 0.5;
const SCALE_MAX = 3;
const SCALE_STEP = 0.15;
const HIGHLIGHT_MS = 4000;

let pdfDoc = null;
let currentScale = 1.25;
let currentPage = 1;
let renderToken = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let highlightFadeTimer = null;
/**
 * Last forward-sync payload (PDF user-space box). Kept across zoom/re-render.
 * @type {{page:number, llx:number, lly:number, urx:number, ury:number}|null}
 */
let activeHighlight = null;
/** Pending until the target page DOM exists (progressive render). */
let pendingHighlight = null;
let pdfjsPromise = null;
let loadedCacheKey = null;

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
  zoomLabel.textContent = `${Math.round(currentScale * 100)}%`;
  btnZoomIn.disabled = !pdfDoc || currentScale >= SCALE_MAX - 1e-9;
  btnZoomOut.disabled = !pdfDoc || currentScale <= SCALE_MIN + 1e-9;
  btnFitWidth.disabled = !pdfDoc;
}

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./pdfjs/pdf.min.mjs').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL(
        './pdfjs/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      return mod;
    });
  }
  return pdfjsPromise;
}

function pdfBoxToViewport(pageViewport, llx, lly, urx, ury) {
  const [x1, y1] = pageViewport.convertToViewportPoint(llx, ury);
  const [x2, y2] = pageViewport.convertToViewportPoint(urx, lly);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return { left, top, width, height };
}

function normalizeHighlight(msg) {
  const llx = msg.llx ?? msg.x ?? 0;
  const lly = msg.lly ?? msg.y ?? 0;
  const urx =
    msg.urx ??
    (msg.width != null ? llx + msg.width : llx + 40);
  const ury =
    msg.ury ??
    (msg.height != null ? lly + msg.height : lly + 12);
  return {
    page: Number(msg.page) || 1,
    llx,
    lly,
    urx,
    ury,
  };
}

function clearHighlightDom() {
  document.querySelectorAll('.highlight').forEach((el) => el.remove());
  if (highlightFadeTimer) {
    clearTimeout(highlightFadeTimer);
    highlightFadeTimer = null;
  }
}

/**
 * Draw highlight for activeHighlight on an already-rendered page.
 * Scrolls the highlight element (not the whole page) into view.
 */
function paintHighlight() {
  clearHighlightDom();
  const msg = activeHighlight;
  if (!msg || !pdfDoc) {
    return;
  }
  const pageDiv = viewer.querySelector(`.page[data-page="${msg.page}"]`);
  if (!pageDiv) {
    pendingHighlight = msg;
    return;
  }
  pendingHighlight = null;

  pdfDoc.getPage(msg.page).then((page) => {
    // Re-check: zoom may have started another render.
    if (!activeHighlight || activeHighlight.page !== msg.page) {
      return;
    }
    const still = viewer.querySelector(`.page[data-page="${msg.page}"]`);
    if (!still) {
      pendingHighlight = msg;
      return;
    }
    const viewport = page.getViewport({ scale: currentScale });
    const box = pdfBoxToViewport(viewport, msg.llx, msg.lly, msg.urx, msg.ury);
    const hl = document.createElement('div');
    hl.className = 'highlight';
    hl.style.left = `${box.left}px`;
    hl.style.top = `${box.top}px`;
    hl.style.width = `${Math.max(box.width, 8)}px`;
    hl.style.height = `${Math.max(box.height, 8)}px`;
    still.appendChild(hl);
    hl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

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
  paintHighlight();
}

function tryPendingHighlight(pageNum) {
  if (pendingHighlight && pendingHighlight.page === pageNum) {
    paintHighlight();
  }
}

async function renderPage(pdf, pageNum, token) {
  if (token !== renderToken) {
    return null;
  }
  const page = await pdf.getPage(pageNum);
  if (token !== renderToken) {
    return null;
  }
  const viewport = page.getViewport({ scale: currentScale });
  const pageDiv = document.createElement('div');
  pageDiv.className = 'page';
  pageDiv.dataset.page = String(pageNum);
  pageDiv.style.width = `${viewport.width}px`;
  pageDiv.style.height = `${viewport.height}px`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  pageDiv.appendChild(canvas);
  viewer.appendChild(pageDiv);

  await page.render({ canvasContext: ctx, viewport }).promise;
  if (token !== renderToken) {
    return null;
  }

  // Capture the viewport used for this render so Ctrl/Cmd+click stays correct after zoom.
  pageDiv.addEventListener('click', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) {
      return;
    }
    ev.preventDefault();
    const rect = pageDiv.getBoundingClientRect();
    const cssX = ev.clientX - rect.left;
    const cssY = ev.clientY - rect.top;
    const [pdfX, pdfY] = viewport.convertToPdfPoint(cssX, cssY);
    vscode.postMessage({
      type: 'click',
      page: pageNum,
      x: pdfX,
      y: pdfY,
    });
  });

  tryPendingHighlight(pageNum);
  return pageDiv;
}

async function renderAllPages(pdf, tDoc) {
  const token = ++renderToken;
  viewer.innerHTML = '';
  updateToolbar();

  const t0 = performance.now();
  await renderPage(pdf, 1, token);
  const firstPageMs = Math.round(performance.now() - t0);
  if (token !== renderToken) {
    return { firstPageMs, renderMs: firstPageMs };
  }

  currentPage = 1;
  updateToolbar();
  setStatus('Ready');
  vscode.postMessage({
    type: 'loaded',
    pages: pdf.numPages,
    loadMs: tDoc,
    firstPageMs,
  });

  // If highlight targets page 1, apply now; later pages apply via tryPendingHighlight.
  if (activeHighlight) {
    paintHighlight();
  }

  for (let pageNum = 2; pageNum <= pdf.numPages; pageNum++) {
    if (token !== renderToken) {
      return { firstPageMs, renderMs: Math.round(performance.now() - t0) };
    }
    await renderPage(pdf, pageNum, token);
  }

  return { firstPageMs, renderMs: Math.round(performance.now() - t0) };
}

async function openDocument(source, cacheKey) {
  if (cacheKey && cacheKey === loadedCacheKey && pdfDoc) {
    setStatus('Ready');
    updateToolbar();
    vscode.postMessage({
      type: 'loaded',
      pages: pdfDoc.numPages,
      reused: true,
    });
    if (activeHighlight) {
      paintHighlight();
    }
    return;
  }

  setStatus('Loading PDF…');
  const tStart = performance.now();
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

    let loadingTask;
    if (source.data != null) {
      const payload =
        source.data instanceof ArrayBuffer
          ? source.data
          : source.data?.buffer
            ? source.data
            : new Uint8Array(source.data);
      loadingTask = pdfjs.getDocument({ data: payload });
    } else {
      loadingTask = pdfjs.getDocument({
        url: source.url,
        withCredentials: false,
        disableAutoFetch: true,
      });
    }

    pdfDoc = await loadingTask.promise;
    const loadMs = Math.round(performance.now() - tStart);
    loadedCacheKey = cacheKey || null;
    currentPage = 1;

    const { firstPageMs, renderMs } = await renderAllPages(pdfDoc, loadMs);
    if (pdfDoc.numPages > 1) {
      vscode.postMessage({
        type: 'loaded',
        pages: pdfDoc.numPages,
        loadMs,
        firstPageMs,
        renderMs,
      });
    }
    setStatus('Ready');
    updateToolbar();
  } catch (err) {
    loadedCacheKey = null;
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Load error: ${message}`);
    vscode.postMessage({ type: 'loadError', message });
  }
}

async function setScale(nextScale, opts = {}) {
  if (!pdfDoc) {
    return;
  }
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, nextScale));
  if (Math.abs(clamped - currentScale) < 1e-6 && !opts.force) {
    updateToolbar();
    return;
  }
  currentScale = clamped;
  updateToolbar();
  setStatus('Zooming…');
  const { firstPageMs, renderMs } = await renderAllPages(pdfDoc, 0);
  setStatus('Ready');
  vscode.postMessage({
    type: 'loaded',
    pages: pdfDoc.numPages,
    firstPageMs,
    renderMs,
    reused: false,
  });
  if (activeHighlight) {
    // After re-render, scroll highlight again at the new scale.
    paintHighlight();
  } else {
    goToPage(currentPage, false);
  }
}

async function fitWidth() {
  if (!pdfDoc) {
    return;
  }
  const page = await pdfDoc.getPage(currentPage || 1);
  const base = page.getViewport({ scale: 1 });
  const available = Math.max(40, viewer.clientWidth - 24);
  const scale = available / base.width;
  await setScale(scale, { force: true });
}

function goToPage(pageNum, updateInput = true) {
  if (!pdfDoc) {
    return;
  }
  const n = Math.min(pdfDoc.numPages, Math.max(1, Math.round(pageNum)));
  currentPage = n;
  if (updateInput) {
    updateToolbar();
  }
  const pageDiv = viewer.querySelector(`.page[data-page="${n}"]`);
  if (pageDiv) {
    pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

btnPrev.addEventListener('click', () => goToPage(currentPage - 1));
btnNext.addEventListener('click', () => goToPage(currentPage + 1));
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
  goToPage(Number(pageInput.value) || 1);
});
pageInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    goToPage(Number(pageInput.value) || 1);
  }
});

viewer.addEventListener('scroll', () => {
  if (!pdfDoc) {
    return;
  }
  const pages = [...viewer.querySelectorAll('.page')];
  if (pages.length === 0) {
    return;
  }
  const mid = viewer.scrollTop + viewer.clientHeight / 3;
  let best = 1;
  for (const el of pages) {
    const top = el.offsetTop;
    if (top <= mid) {
      best = Number(el.dataset.page) || best;
    }
  }
  if (best !== currentPage) {
    currentPage = best;
    updateToolbar();
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
        openDocument({ data: msg.data }, msg.cacheKey);
      } else if (msg.url) {
        openDocument({ url: msg.url }, msg.cacheKey);
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
