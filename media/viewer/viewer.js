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

function setStatus(text, building = false) {
  statusText.textContent = text;
  document.body.classList.toggle('building', building);
}

async function loadPdfJs() {
  const mod = await import('./pdfjs/pdf.min.mjs');
  mod.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).toString();
  return mod;
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

async function renderAllPages(pdf) {
  const token = ++renderToken;
  viewer.innerHTML = '';
  pageInfo.textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    if (token !== renderToken) {
      return;
    }
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale });
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page';
    pageDiv.dataset.page = String(pageNum);
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
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
      // Convert CSS viewport coords → PDF user space (origin bottom-left)
      const [pdfX, pdfY] = viewport.convertToPdfPoint(cssX, cssY);
      vscode.postMessage({
        type: 'click',
        page: pageNum,
        x: pdfX,
        y: pdfY,
      });
    });
  }

  if (pendingHighlight) {
    applyHighlight(pendingHighlight);
    pendingHighlight = null;
  }
}

async function openDocumentFromUrl(url) {
  setStatus('Loading PDF…');
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
    const loadingTask = pdfjs.getDocument({ url, withCredentials: false });
    pdfDoc = await loadingTask.promise;
    await renderAllPages(pdfDoc);
    setStatus('Ready');
    vscode.postMessage({ type: 'loaded', pages: pdfDoc.numPages });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Load error: ${message}`);
    vscode.postMessage({ type: 'loadError', message });
  }
}

/**
 * Fallback when asWebviewUri fetch 401s: host posts PDF bytes.
 */
async function openDocumentFromData(data) {
  setStatus('Loading PDF…');
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
    const payload =
      data instanceof ArrayBuffer
        ? data
        : data?.buffer
          ? data
          : new Uint8Array(data);
    const loadingTask = pdfjs.getDocument({ data: payload });
    pdfDoc = await loadingTask.promise;
    await renderAllPages(pdfDoc);
    setStatus('Ready');
    vscode.postMessage({ type: 'loaded', pages: pdfDoc.numPages });
  } catch (err) {
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
        openDocumentFromData(msg.data);
      } else if (msg.url) {
        openDocumentFromUrl(msg.url);
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
