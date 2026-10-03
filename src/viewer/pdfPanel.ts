import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { PdfRangeServer } from './pdfServer';
import { pdfPanelTitle } from './pdfPanelTitle';

export type ViewerMessage =
  | { type: 'ready' }
  | {
      type: 'loaded';
      pages: number;
      loadMs?: number;
      firstPageMs?: number;
      renderMs?: number;
      bytesFetched?: number;
      worker?: 'real' | 'fake' | 'unknown';
      useRange?: boolean;
      reused?: boolean;
      virtual?: boolean;
    }
  | { type: 'loadError'; message: string }
  | { type: 'click'; page: number; x: number; y: number; pdfY?: number; pageHeight?: number }
  | { type: 'openExternal'; url: string }
  | {
      type: 'highlight';
      page: number;
      viewportLeft: number;
      top: number;
      w: number;
      h: number;
      scale: number;
      llx?: number;
      lly?: number;
      urx?: number;
      ury?: number;
      /** Forward SyncTeX scroll diagnostics (optional). */
      scrollTopBefore?: number;
      scrollTopAfter?: number;
      clientHeight?: number;
      scrollHeight?: number;
      pageOffsetTop?: number;
      pageOffsetHeight?: number;
      rawCanvasTop?: number;
      clampedCanvasTop?: number;
      simpleMtxCssTop?: number;
      intendedScrollTop?: number;
      pageView?: number[];
      viewportHeight?: number;
    }
  | {
      type: 'forwardSyncDiag';
      phase: 'page-center' | 'highlight';
      page: number;
      scale: number;
      llx?: number;
      lly?: number;
      urx?: number;
      ury?: number;
      scrollTopBefore?: number;
      scrollTopAfter?: number;
      clientHeight?: number;
      scrollHeight?: number;
      pageOffsetTop?: number;
      pageOffsetHeight?: number;
      rawCanvasTop?: number;
      clampedCanvasTop?: number;
      simpleMtxCssTop?: number;
      intendedScrollTop?: number;
      pageView?: number[];
      viewportHeight?: number;
      viewportLeft?: number;
      top?: number;
      w?: number;
      h?: number;
    };

export interface ForwardSyncPayload {
  page: number;
  llx: number;
  lly: number;
  urx: number;
  ury: number;
  /** Estimated synctex page height (pt, top-down space). Used to scale to PDF.js view. */
  synctexPageH?: number;
  /** Estimated synctex page width (pt). */
  synctexPageW?: number;
  /** When true, scroll to the page but do not paint an edge-band highlight. */
  skipHighlight?: boolean;
}

export type PdfPanelState = {
  pdfPath?: string;
  jobDir?: string;
};

export { DEFAULT_PDF_PANEL_TITLE, pdfPanelTitle } from './pdfPanelTitle';

/**
 * PDF.js webview panel.
 *
 * Happy path: serve the gated job PDF from a loopback range server so PDF.js
 * can fetch the first page without downloading the whole file via vscode-cdn.
 * Falls back to asWebviewUri, then bytes on 401.
 *
 * Singleton: one live webview for `context.pdfPreview`. Restored panels are
 * adopted via {@link adoptPanel}; {@link setJobDir} updates resource roots
 * without dispose+recreate.
 */
export class PdfPanel {
  public static readonly viewType = 'context.pdfPreview';

  /** Restored by serializer before (or instead of) createWebviewPanel. */
  private static pendingRestored: vscode.WebviewPanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  private currentPdfPath: string | undefined;
  private currentMtimeMs: number | undefined;
  private previousPdfPath: string | undefined;
  private jobDirRoots: vscode.Uri[] = [];
  private building = false;
  private recovering = false;
  private preferBytesFallback = false;
  private preferWebviewUri = false;
  private loadStartedAt = 0;
  /** cacheKey currently shown / confirmed by the webview */
  private loadedCacheKey: string | undefined;
  /** cacheKey of an in-flight loadPdf — blocks duplicates */
  private loadInFlightKey: string | undefined;
  /**
   * Webview script posted `ready`. Until then, loadPdf messages are lost
   * (serializer/adopt often races ahead of the fresh document).
   */
  private webviewReady = false;
  /** Queued while waiting for {@link webviewReady}. */
  private pendingLoad: { pdfPath: string; cacheKey: string } | undefined;
  private loadWatchdog: ReturnType<typeof setTimeout> | undefined;
  private readonly rangeServer = new PdfRangeServer();
  private messageSub: vscode.Disposable | undefined;
  private disposeSub: vscode.Disposable | undefined;

  private static readonly LOAD_TIMEOUT_MS = 20_000;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onClick: (
      page: number,
      x: number,
      y: number,
      meta?: { pdfY?: number; pageHeight?: number },
    ) => void,
    private readonly onLog?: (message: string) => void,
  ) {
    this.jobDirRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
  }

  /** Stash a panel from {@link vscode.window.registerWebviewPanelSerializer}. */
  public static stashRestoredPanel(panel: vscode.WebviewPanel): void {
    if (PdfPanel.pendingRestored && PdfPanel.pendingRestored !== panel) {
      PdfPanel.pendingRestored.dispose();
    }
    PdfPanel.pendingRestored = panel;
  }

  public dispose(): void {
    this.clearLoadWatchdog();
    this.messageSub?.dispose();
    this.disposeSub?.dispose();
    this.panel?.dispose();
    this.panel = undefined;
    this.webviewReady = false;
    this.pendingLoad = undefined;
    this.rangeServer.dispose();
  }

  private clearLoadWatchdog(): void {
    if (this.loadWatchdog != null) {
      clearTimeout(this.loadWatchdog);
      this.loadWatchdog = undefined;
    }
  }

  /** Surface a stuck load (progress forever, no `loaded` / `loadError`). */
  private armLoadWatchdog(cacheKey: string): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      this.loadWatchdog = undefined;
      if (this.loadInFlightKey !== cacheKey || this.loadedCacheKey === cacheKey) {
        return;
      }
      this.onLog?.(`[viewer] load timed out cacheKey=${cacheKey}`);
      void this.recoverFromLoadError(
        'PDF load timed out (webview did not report loaded)',
      );
    }, PdfPanel.LOAD_TIMEOUT_MS);
  }

  public hasPanel(): boolean {
    return !!this.panel;
  }

  /**
   * Adopt a restored or pre-existing webview panel (serializer / reuse).
   * If this controller already owns a different panel, the other is disposed
   * so only one `context.pdfPreview` tab remains.
   *
   * Always refreshes HTML and waits for a new `ready` before loadPdf: after
   * window reload the prior loopback range server is dead, and posting
   * loadPdf before the webview listens leaves the progress bar stuck.
   */
  public adoptPanel(panel: vscode.WebviewPanel): void {
    if (PdfPanel.pendingRestored === panel) {
      PdfPanel.pendingRestored = undefined;
    }
    this.webviewReady = false;
    this.loadedCacheKey = undefined;
    this.loadInFlightKey = undefined;
    this.pendingLoad = undefined;
    this.clearLoadWatchdog();
    if (this.panel && this.panel !== panel) {
      const old = this.panel;
      this.panel = undefined;
      this.messageSub?.dispose();
      this.disposeSub?.dispose();
      old.dispose();
    }
    // Force HTML so the script rebinds and posts `ready` (then we reload PDF).
    this.wirePanel(panel, true);
  }

  public setJobDir(jobDir: string): void {
    const jobUri = vscode.Uri.file(path.resolve(jobDir));
    if (this.jobDirRoots.some((u) => u.fsPath === jobUri.fsPath)) {
      return;
    }
    this.jobDirRoots = [jobUri, ...this.jobDirRoots];
    // Update roots in place — dispose+recreate used to multiply tabs and
    // retrigger ready→loadPdf. Range-server happy path does not need roots.
    if (this.panel && this.preferWebviewUri) {
      this.panel.webview.options = {
        enableScripts: true,
        localResourceRoots: this.resourceRoots(),
      };
    }
  }

  private resourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer'),
      ...this.jobDirRoots,
    ];
  }

  private wirePanel(panel: vscode.WebviewPanel, resetHtml: boolean): void {
    this.panel = panel;
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(),
    };
    if (resetHtml || !this.panel.webview.html) {
      // New document → must wait for `ready` again before loadPdf.
      this.webviewReady = false;
      this.panel.webview.html = this.getHtml(this.panel.webview);
    }
    this.messageSub?.dispose();
    this.messageSub = this.panel.webview.onDidReceiveMessage((msg: ViewerMessage) => {
      this.handleMessage(msg);
    });
    this.disposeSub?.dispose();
    this.disposeSub = this.panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.webviewReady = false;
        this.pendingLoad = undefined;
        this.loadedCacheKey = undefined;
        this.loadInFlightKey = undefined;
        this.clearLoadWatchdog();
      }
    });
    this.applyPanelTitle();
  }

  private findExistingViewTypePanel(): vscode.WebviewPanel | undefined {
    if (PdfPanel.pendingRestored) {
      const pending = PdfPanel.pendingRestored;
      PdfPanel.pendingRestored = undefined;
      return pending;
    }
    return undefined;
  }

  /**
   * Reveal an existing PDF panel or create one.
   * @param preserveFocus When true, keep editor focus (VS Code reveal/create preserveFocus).
   */
  public revealOrCreate(
    column?: vscode.ViewColumn,
    preserveFocus = false,
  ): vscode.WebviewPanel {
    if (!this.panel) {
      const existing = this.findExistingViewTypePanel();
      if (existing) {
        this.adoptPanel(existing);
      }
    }

    if (this.panel) {
      this.panel.reveal(column ?? vscode.ViewColumn.Beside, preserveFocus);
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
      PdfPanel.viewType,
      pdfPanelTitle(this.currentPdfPath),
      {
        viewColumn: column ?? vscode.ViewColumn.Beside,
        preserveFocus,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.resourceRoots(),
      },
    );

    this.wirePanel(this.panel, true);
    return this.panel;
  }

  public setBuilding(building: boolean, message?: string): void {
    this.building = building;
    if (!this.panel) {
      return;
    }
    if (building) {
      void this.panel.webview.postMessage({
        type: 'building',
        message: message ?? 'Building…',
      });
    } else {
      void this.panel.webview.postMessage({
        type: 'idle',
        message: message ?? 'Ready',
      });
    }
  }

  /**
   * Show / reload the gated job PDF.
   * @param opts.preserveFocus When true, never take focus. When omitted, preserve
   *   focus only if the panel already exists (reload/refresh); new panels take focus.
   */
  public async showJobPdf(
    jobPdfPath: string,
    jobDir: string,
    opts?: { preserveFocus?: boolean },
  ): Promise<void> {
    this.setJobDir(jobDir);
    const preserveFocus = opts?.preserveFocus ?? !!this.panel;
    this.revealOrCreate(undefined, preserveFocus);
    if (this.panel) {
      this.panel.title = pdfPanelTitle(jobPdfPath);
    }
    if (!fs.existsSync(jobPdfPath)) {
      void this.panel?.webview.postMessage({
        type: 'error',
        message: `PDF missing: ${jobPdfPath}`,
      });
      return;
    }

    const mtimeMs = fs.statSync(jobPdfPath).mtimeMs;
    const cacheKey = `${jobPdfPath}:${mtimeMs}`;
    if (
      this.panel &&
      this.currentPdfPath === jobPdfPath &&
      this.currentMtimeMs === mtimeMs &&
      this.loadedCacheKey === cacheKey
    ) {
      this.onLog?.(`[viewer] skip reload (unchanged) ${jobPdfPath}`);
      return;
    }

    if (this.loadInFlightKey === cacheKey) {
      this.onLog?.(`[viewer] skip reload (in flight) ${cacheKey}`);
      return;
    }

    if (this.currentPdfPath && this.currentPdfPath !== jobPdfPath) {
      this.previousPdfPath = this.currentPdfPath;
    }
    this.currentPdfPath = jobPdfPath;
    this.currentMtimeMs = mtimeMs;
    this.applyPanelTitle();
    await this.loadPdf(jobPdfPath, cacheKey);
  }

  private applyPanelTitle(): void {
    if (this.panel) {
      this.panel.title = pdfPanelTitle(this.currentPdfPath);
    }
  }

  public async forwardSync(payload: ForwardSyncPayload): Promise<void> {
    this.revealOrCreate();
    await this.panel!.webview.postMessage({
      type: 'forwardSync',
      page: payload.page,
      llx: payload.llx,
      lly: payload.lly,
      urx: payload.urx,
      ury: payload.ury,
      x: payload.llx,
      y: payload.lly,
      width: payload.urx - payload.llx,
      height: payload.ury - payload.lly,
      synctexPageH: payload.synctexPageH,
      synctexPageW: payload.synctexPageW,
      skipHighlight: payload.skipHighlight === true,
    });
  }

  public getCurrentPdfPath(): string | undefined {
    return this.currentPdfPath;
  }

  /** Host-side state for serializer revive after reload. */
  public getPersistedState(): PdfPanelState {
    return {
      pdfPath: this.currentPdfPath,
      jobDir: this.currentPdfPath ? path.dirname(this.currentPdfPath) : undefined,
    };
  }

  private async loadPdf(pdfPath: string, cacheKey: string): Promise<void> {
    if (!this.panel) {
      return;
    }
    // After adopt/restore the webview document is new; posts before `ready`
    // never reach the script and leave the progress UI stuck.
    if (!this.webviewReady) {
      this.pendingLoad = { pdfPath, cacheKey };
      this.onLog?.(`[viewer] loadPdf deferred (waiting for webview ready) ${cacheKey}`);
      return;
    }
    if (this.loadInFlightKey === cacheKey) {
      return;
    }
    this.pendingLoad = undefined;
    this.loadInFlightKey = cacheKey;
    this.loadStartedAt = Date.now();
    this.armLoadWatchdog(cacheKey);

    try {
      if (this.preferBytesFallback) {
        await this.postPdfBytes(pdfPath, cacheKey);
        return;
      }

      if (!this.preferWebviewUri) {
        // Ensure a live loopback server for this session (prior session is dead).
        const rangeUrl = await this.rangeServer.serve(pdfPath);
        if (rangeUrl) {
          this.onLog?.(`[viewer] loadPdf rangeServer=${rangeUrl}`);
          await this.panel.webview.postMessage({
            type: 'loadPdf',
            url: rangeUrl,
            cacheKey,
            useRange: true,
          });
          return;
        }
        this.onLog?.('[viewer] range server unavailable; falling back to asWebviewUri');
        this.preferWebviewUri = true;
      }

      const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(pdfPath));
      this.onLog?.(`[viewer] loadPdf url=${uri.toString()}`);
      await this.panel.webview.postMessage({
        type: 'loadPdf',
        url: uri.toString(),
        cacheKey,
        useRange: false,
      });
    } catch (err) {
      this.clearLoadWatchdog();
      this.loadInFlightKey = undefined;
      const message = err instanceof Error ? err.message : String(err);
      void this.panel?.webview.postMessage({
        type: 'error',
        message: `Failed to start PDF load: ${message}`,
      });
    }
  }

  private async postPdfBytes(pdfPath: string, cacheKey: string): Promise<void> {
    try {
      const t0 = Date.now();
      const buf = await fsp.readFile(pdfPath);
      const data = new Uint8Array(buf);
      this.onLog?.(
        `[viewer] bytes fallback size=${data.byteLength} readMs=${Date.now() - t0}`,
      );
      await this.panel!.webview.postMessage({
        type: 'loadPdf',
        data,
        cacheKey,
      });
    } catch (err) {
      this.clearLoadWatchdog();
      this.loadInFlightKey = undefined;
      const message = err instanceof Error ? err.message : String(err);
      void this.panel?.webview.postMessage({
        type: 'error',
        message: `Failed to read PDF: ${message}`,
      });
    }
  }

  private async recoverFromLoadError(message: string): Promise<void> {
    this.clearLoadWatchdog();
    this.loadInFlightKey = undefined;
    const is401 = /401|Unexpected server response/i.test(message);
    const isFetch =
      /Failed to fetch|NetworkError|ERR_|Load failed/i.test(message);
    const isTimeout = /timed out/i.test(message);

    if (
      !this.preferWebviewUri &&
      !this.preferBytesFallback &&
      this.currentPdfPath &&
      (is401 || isFetch || isTimeout)
    ) {
      this.preferWebviewUri = true;
      this.onLog?.(
        `[viewer] range URL failed (${message}); trying asWebviewUri`,
      );
      const key = `${this.currentPdfPath}:${this.currentMtimeMs ?? 0}`;
      await this.loadPdf(this.currentPdfPath, key);
      return;
    }

    if (
      (is401 || isTimeout) &&
      !this.preferBytesFallback &&
      this.currentPdfPath
    ) {
      this.preferBytesFallback = true;
      void vscode.window.showWarningMessage(
        isTimeout
          ? 'PDF load timed out. Falling back to in-memory bytes for this session.'
          : 'PDF URI load failed (401). Falling back to in-memory bytes for this session.',
      );
      const key = `${this.currentPdfPath}:${this.currentMtimeMs ?? 0}`;
      await this.postPdfBytes(this.currentPdfPath, key);
      return;
    }

    if (this.recovering) {
      void vscode.window.showErrorMessage(`PDF load failed: ${message}`);
      void this.panel?.webview.postMessage({
        type: 'error',
        message: `Load failed: ${message}`,
      });
      return;
    }

    const fallback = this.previousPdfPath;
    if (fallback && fallback !== this.currentPdfPath && fs.existsSync(fallback)) {
      this.recovering = true;
      void vscode.window.showWarningMessage(
        `PDF load failed (${message}). Restoring previous PDF.`,
      );
      this.currentPdfPath = fallback;
      this.applyPanelTitle();
      try {
        this.currentMtimeMs = fs.statSync(fallback).mtimeMs;
        const key = `${fallback}:${this.currentMtimeMs}`;
        await this.loadPdf(fallback, key);
      } finally {
        this.recovering = false;
      }
      return;
    }
    void vscode.window.showErrorMessage(`PDF load failed: ${message}`);
    void this.panel?.webview.postMessage({
      type: 'error',
      message: `Load failed: ${message}`,
    });
  }

  private logForwardScrollDiag(
    phase: string,
    msg: {
      page: number;
      scale?: number;
      llx?: number;
      lly?: number;
      urx?: number;
      ury?: number;
      scrollTopBefore?: number;
      scrollTopAfter?: number;
      clientHeight?: number;
      scrollHeight?: number;
      pageOffsetTop?: number;
      pageOffsetHeight?: number;
      rawCanvasTop?: number;
      clampedCanvasTop?: number;
      simpleMtxCssTop?: number;
      intendedScrollTop?: number;
      pageView?: number[];
      viewportHeight?: number;
      viewportLeft?: number;
      top?: number;
      w?: number;
      h?: number;
    },
  ): void {
    if (
      msg.scrollTopBefore == null &&
      msg.intendedScrollTop == null &&
      msg.pageOffsetTop == null
    ) {
      return;
    }
    this.onLog?.(
      `[viewer] forward-scroll (${phase}) page=${msg.page}` +
        (msg.scrollTopBefore != null
          ? ` scrollTopBefore=${msg.scrollTopBefore.toFixed(1)}`
          : '') +
        (msg.scrollTopAfter != null
          ? ` scrollTopAfter=${msg.scrollTopAfter.toFixed(1)}`
          : '') +
        (msg.intendedScrollTop != null
          ? ` intendedScrollTop=${msg.intendedScrollTop.toFixed(1)}`
          : '') +
        (msg.clientHeight != null
          ? ` clientH=${msg.clientHeight.toFixed(1)}`
          : '') +
        (msg.scrollHeight != null
          ? ` scrollH=${msg.scrollHeight.toFixed(1)}`
          : '') +
        (msg.pageOffsetTop != null
          ? ` pageOffsetTop=${msg.pageOffsetTop.toFixed(1)}`
          : '') +
        (msg.pageOffsetHeight != null
          ? ` pageOffsetH=${msg.pageOffsetHeight.toFixed(1)}`
          : '') +
        (msg.rawCanvasTop != null
          ? ` rawCanvasY=${msg.rawCanvasTop.toFixed(1)}`
          : '') +
        (msg.clampedCanvasTop != null
          ? ` clampedCanvasY=${msg.clampedCanvasTop.toFixed(1)}`
          : '') +
        (msg.simpleMtxCssTop != null
          ? ` simpleMtxCssTop=${msg.simpleMtxCssTop.toFixed(1)}`
          : '') +
        (msg.viewportHeight != null
          ? ` viewportH=${msg.viewportHeight.toFixed(1)}`
          : '') +
        (msg.pageView != null ? ` pageView=[${msg.pageView.join(',')}]` : ''),
    );
  }

  private handleMessage(msg: ViewerMessage): void {
    switch (msg.type) {
      case 'ready': {
        // Fresh webview document: any prior loadPdf post was lost.
        this.webviewReady = true;
        this.loadInFlightKey = undefined;
        this.loadedCacheKey = undefined;
        this.clearLoadWatchdog();
        const pending = this.pendingLoad;
        this.pendingLoad = undefined;
        if (pending) {
          this.onLog?.(`[viewer] ready → flush deferred load ${pending.cacheKey}`);
          void this.loadPdf(pending.pdfPath, pending.cacheKey);
        } else if (this.currentPdfPath && this.currentMtimeMs != null) {
          const key = `${this.currentPdfPath}:${this.currentMtimeMs}`;
          this.onLog?.(`[viewer] ready → reload ${key}`);
          void this.loadPdf(this.currentPdfPath, key);
        } else {
          this.onLog?.('[viewer] ready (no PDF path yet)');
        }
        if (this.building) {
          this.setBuilding(true);
        }
        break;
      }
      case 'loaded': {
        this.clearLoadWatchdog();
        this.loadInFlightKey = undefined;
        if (this.currentPdfPath && this.currentMtimeMs != null) {
          this.loadedCacheKey = `${this.currentPdfPath}:${this.currentMtimeMs}`;
        }
        const hostMs = this.loadStartedAt ? Date.now() - this.loadStartedAt : undefined;
        const rangeStats = this.rangeServer.getStats();
        this.onLog?.(
          `[viewer] loaded pages=${msg.pages}` +
            (msg.worker != null ? ` worker=${msg.worker}` : '') +
            (msg.loadMs != null ? ` getDocumentMs=${msg.loadMs}` : '') +
            (msg.firstPageMs != null ? ` firstPageMs=${msg.firstPageMs}` : '') +
            (msg.renderMs != null ? ` renderMs=${msg.renderMs}` : '') +
            (msg.bytesFetched != null
              ? ` bytesFetched=${msg.bytesFetched}`
              : '') +
            (hostMs != null ? ` hostRoundtripMs=${hostMs}` : '') +
            (msg.useRange
              ? ` rangeReqs=${rangeStats.rangeRequests}` +
                ` fullReqs=${rangeStats.fullRequests}` +
                ` rangeBytes=${rangeStats.bytesServed}`
              : '') +
            (msg.reused ? ' reused=1' : '') +
            (msg.virtual ? ' virtual=1' : ''),
        );
        break;
      }
      case 'highlight':
        this.onLog?.(
          `[viewer] highlight page=${msg.page}` +
            ` viewportLeft=${msg.viewportLeft.toFixed(1)}` +
            ` top=${msg.top.toFixed(1)}` +
            ` w=${msg.w.toFixed(1)} h=${msg.h.toFixed(1)}` +
            ` scale=${msg.scale.toFixed(3)}` +
            (msg.llx != null
              ? ` llx=${msg.llx} lly=${msg.lly} urx=${msg.urx} ury=${msg.ury}`
              : ''),
        );
        this.logForwardScrollDiag('highlight', msg);
        break;
      case 'forwardSyncDiag':
        this.logForwardScrollDiag(msg.phase, msg);
        break;
      case 'loadError':
        void this.recoverFromLoadError(msg.message);
        break;
      case 'click':
        this.onClick(msg.page, msg.x, msg.y, {
          pdfY: msg.pdfY,
          pageHeight: msg.pageHeight,
        });
        break;
      case 'openExternal': {
        const raw = typeof msg.url === 'string' ? msg.url.trim() : '';
        if (!raw) {
          break;
        }
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(raw);
        } catch {
          this.onLog?.(`[viewer] openExternal rejected (parse): ${raw}`);
          break;
        }
        const scheme = uri.scheme.toLowerCase();
        if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') {
          this.onLog?.(`[viewer] openExternal rejected (scheme=${scheme})`);
          break;
        }
        this.onLog?.(`[viewer] openExternal ${uri.toString(true)}`);
        void vscode.env.openExternal(uri);
        break;
      }
      default:
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer');
    const htmlPath = path.join(mediaRoot.fsPath, 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const asWeb = (rel: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, rel)).toString();

    html = html
      .replace('href="viewer.css"', `href="${asWeb('viewer.css')}"`)
      .replace('src="viewer.js"', `src="${asWeb('viewer.js')}"`);

    // worker-src blob: is required for the PDF.js dedicated worker created
    // from a blob URL (vscode-cdn workerSrc is cross-origin and falls back
    // to a fake/main-thread worker). script-src blob: covers module workers
    // on older Electron CSP implementations.
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline' blob:`,
      `worker-src ${webview.cspSource} blob:`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
      // Range server + vscode-resource fallback
      `connect-src ${webview.cspSource} http://127.0.0.1:* http://localhost:*`,
    ].join('; ');

    if (!html.includes('Content-Security-Policy')) {
      html = html.replace(
        '<head>',
        `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    }
    return html;
  }
}
