/* global vscode API injected by host */
const vscode = acquireVsCodeApi();

const statusText = document.getElementById('statusText');
const pageInfo = document.getElementById('pageInfo');
const viewer = document.getElementById('viewer');

let pdfDoc = null;
let currentScale = 1.25;
let renderToken = 0;
/** @type {{page:number,x:number,y:number,w:number,h:number}|null} */
let pendingHighlight = null;
/** Cached PDF.js module promise — avoid re-importing worker/assets every load. */
let pdfjsPromise = null;
/** Last opened document cache key (path:mtime) to skip identical reloads. */
let loadedCacheKey = null;

function setStatus(text, building = false) {
  statusText.textContent = text;
  document.body.classList.toggle('building', building);
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

/**
 * ConTeXt / SyncTeX use PDF user space (bp from bottom-left).
 * PDF.js viewport uses top-left CSS pixels. Convert box for highlight.
 */
function pdfBoxToViewport(pageViewport, llx, lly, urx, ury) {
  const [x1, y1] = pageViewport.convertToViewportPoint(llx, ury);
  const [x2, y2] = pageViewport.convertToViewportPoint(urx, lly);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return { left, top, width, height };
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

  return pageDiv;
}

/**
 * Progressive render: first page ASAP (usable viewer), then remaining pages.
 * Avoids serial full-document wait of 10–20s before anything appears.
 */
async function renderAllPages(pdf, tDoc) {
  const token = ++renderToken;
  viewer.innerHTML = '';
  pageInfo.textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;

  const t0 = performance.now();
  await renderPage(pdf, 1, token);
  const firstPageMs = Math.round(performance.now() - t0);
  if (token !== renderToken) {
    return { firstPageMs, renderMs: firstPageMs };
  }

  setStatus('Ready');
  vscode.postMessage({
    type: 'loaded',
    pages: pdf.numPages,
    loadMs: tDoc,
    firstPageMs,
  });

  for (let pageNum = 2; pageNum <= pdf.numPages; pageNum++) {
    if (token !== renderToken) {
      return { firstPageMs, renderMs: Math.round(performance.now() - t0) };
    }
    await renderPage(pdf, pageNum, token);
  }

  if (pendingHighlight) {
    applyHighlight(pendingHighlight);
    pendingHighlight = null;
  }

  return { firstPageMs, renderMs: Math.round(performance.now() - t0) };
}

async function openDocument(source, cacheKey) {
  if (cacheKey && cacheKey === loadedCacheKey && pdfDoc) {
    setStatus('Ready');
    vscode.postMessage({
      type: 'loaded',
      pages: pdfDoc.numPages,
      reused: true,
    });
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
        // Local vscode-resource: skip speculative page fetches beyond the request.
        disableAutoFetch: true,
      });
    }

    pdfDoc = await loadingTask.promise;
    const loadMs = Math.round(performance.now() - tStart);
    loadedCacheKey = cacheKey || null;

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
  } catch (err) {
    loadedCacheKey = null;
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Load error: ${message}`);
    vscode.postMessage({ type: 'loadError', message });
  }
}

function applyHighlight(msg) {
  document.querySelectorAll('.highlight').forEach((el) => el.remove());
  const pageDiv = viewer.querySelector(`.page[data-page="${msg.page}"]`);
  if (!pageDiv || !pdfDoc) {
    pendingHighlight = msg;
    return;
  }

  pdfDoc.getPage(msg.page).then((page) => {
    const viewport = page.getViewport({ scale: currentScale });
    const box = pdfBoxToViewport(
      viewport,
      msg.x ?? msg.llx ?? 0,
      msg.y ?? msg.lly ?? 0,
      msg.width != null ? (msg.x ?? msg.llx ?? 0) + msg.width : msg.urx ?? (msg.x ?? 0) + 40,
      msg.height != null ? (msg.y ?? msg.lly ?? 0) + msg.height : msg.ury ?? (msg.y ?? 0) + 12,
    );
    const hl = document.createElement('div');
    hl.className = 'highlight';
    hl.style.left = `${box.left}px`;
    hl.style.top = `${box.top}px`;
    hl.style.width = `${Math.max(box.width, 8)}px`;
    hl.style.height = `${Math.max(box.height, 8)}px`;
    pageDiv.appendChild(hl);
    pageDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      hl.style.opacity = '0';
    }, 2000);
  });
}

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

vscode.postMessage({ type: 'ready' });
