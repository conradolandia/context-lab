import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

export type ViewerMessage =
  | { type: 'ready' }
  | { type: 'loaded'; pages: number }
  | { type: 'loadError'; message: string }
  | { type: 'click'; page: number; x: number; y: number };

export interface ForwardSyncPayload {
  page: number;
  llx: number;
  lly: number;
  urx: number;
  ury: number;
}

/**
 * PDF.js webview panel.
 *
 * Happy path: load the real gated job PDF via asWebviewUri with the job
 * directory (and workspace folders) in localResourceRoots.
 * Fallback: post PDF bytes only if the URI fetch 401s.
 * Never reload mid-compile — caller only invokes showJobPdf after the gate.
 */
export class PdfPanel {
  public static readonly viewType = 'context.pdfPreview';

  private panel: vscode.WebviewPanel | undefined;
  private currentPdfPath: string | undefined;
  private previousPdfPath: string | undefined;
  private jobDirRoots: vscode.Uri[] = [];
  private building = false;
  private recovering = false;
  private preferBytesFallback = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onClick: (page: number, x: number, y: number) => void,
  ) {}

  /** Ensure jobDir (and workspace folders) are allowed for asWebviewUri. */
  public setJobDir(jobDir: string): void {
    const jobUri = vscode.Uri.file(path.resolve(jobDir));
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    const next = [jobUri, ...workspaceRoots];
    const same =
      next.length === this.jobDirRoots.length &&
      next.every((u, i) => u.fsPath === this.jobDirRoots[i]?.fsPath);
    this.jobDirRoots = next;
    if (this.panel && !same) {
      const col = this.panel.viewColumn;
      this.panel.dispose();
      this.panel = undefined;
      this.revealOrCreate(col);
    }
  }

  private resourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer'),
      ...this.jobDirRoots,
    ];
  }

  public revealOrCreate(column?: vscode.ViewColumn): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(column ?? vscode.ViewColumn.Beside);
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
      PdfPanel.viewType,
      'ConTeXt PDF',
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.resourceRoots(),
      },
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg: ViewerMessage) => {
      this.handleMessage(msg);
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

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
   * Load the gated job PDF. Call only after exit 0 + stability gate.
   * Keeps previous path for load-error recovery.
   */
  public async showJobPdf(jobPdfPath: string, jobDir: string): Promise<void> {
    this.setJobDir(jobDir);
    this.revealOrCreate();
    if (!fs.existsSync(jobPdfPath)) {
      void this.panel?.webview.postMessage({
        type: 'error',
        message: `PDF missing: ${jobPdfPath}`,
      });
      return;
    }

    if (this.currentPdfPath && this.currentPdfPath !== jobPdfPath) {
      this.previousPdfPath = this.currentPdfPath;
    }
    this.currentPdfPath = jobPdfPath;
    await this.loadPdf(jobPdfPath);
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
    });
  }

  public getCurrentPdfPath(): string | undefined {
    return this.currentPdfPath;
  }

  private async loadPdf(pdfPath: string): Promise<void> {
    if (this.preferBytesFallback) {
      await this.postPdfBytes(pdfPath);
      return;
    }
    const uri = this.panel!.webview.asWebviewUri(vscode.Uri.file(pdfPath));
    await this.panel!.webview.postMessage({
      type: 'loadPdf',
      url: uri.toString(),
    });
  }

  private async postPdfBytes(pdfPath: string): Promise<void> {
    try {
      const buf = await fsp.readFile(pdfPath);
      const data = new Uint8Array(buf);
      await this.panel!.webview.postMessage({
        type: 'loadPdf',
        data,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel?.webview.postMessage({
        type: 'error',
        message: `Failed to read PDF: ${message}`,
      });
    }
  }

  private async recoverFromLoadError(message: string): Promise<void> {
    const is401 = /401|Unexpected server response/i.test(message);

    if (is401 && !this.preferBytesFallback && this.currentPdfPath) {
      this.preferBytesFallback = true;
      void vscode.window.showWarningMessage(
        'PDF URI load failed (401). Falling back to in-memory bytes for this session.',
      );
      await this.postPdfBytes(this.currentPdfPath);
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
      try {
        await this.loadPdf(fallback);
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

  private handleMessage(msg: ViewerMessage): void {
    switch (msg.type) {
      case 'ready':
        if (this.currentPdfPath) {
          void this.loadPdf(this.currentPdfPath);
        }
        if (this.building) {
          this.setBuilding(true);
        }
        break;
      case 'loadError':
        void this.recoverFromLoadError(msg.message);
        break;
      case 'click':
        this.onClick(msg.page, msg.x, msg.y);
        break;
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

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
      `worker-src ${webview.cspSource} blob:`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
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
