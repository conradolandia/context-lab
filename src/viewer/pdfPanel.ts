import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

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
 * PDF.js webview panel. Loads only extension-cache PDF snapshots — never the live job PDF.
 */
export class PdfPanel {
  public static readonly viewType = 'context.pdfPreview';

  private panel: vscode.WebviewPanel | undefined;
  private currentSnapshot: string | undefined;
  private previousSnapshot: string | undefined;
  private building = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cacheUri: vscode.Uri,
    private readonly onClick: (page: number, x: number, y: number) => void,
  ) {}

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
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer'),
          this.cacheUri,
        ],
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
   * Point the viewer at a new cache snapshot. Keeps previousSnapshot for load-error recovery.
   * Does nothing destructive at build start — call only after the artifact gate succeeds.
   */
  public async showSnapshot(snapshotPdfPath: string): Promise<void> {
    this.revealOrCreate();
    if (!fs.existsSync(snapshotPdfPath)) {
      void this.panel?.webview.postMessage({
        type: 'error',
        message: `Snapshot missing: ${snapshotPdfPath}`,
      });
      return;
    }

    if (this.currentSnapshot && this.currentSnapshot !== snapshotPdfPath) {
      this.previousSnapshot = this.currentSnapshot;
    }
    this.currentSnapshot = snapshotPdfPath;

    const uri = this.panel!.webview.asWebviewUri(vscode.Uri.file(snapshotPdfPath));
    await this.panel!.webview.postMessage({
      type: 'loadPdf',
      url: uri.toString(),
    });
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

  public getCurrentSnapshot(): string | undefined {
    return this.currentSnapshot;
  }

  private async recoverFromLoadError(message: string): Promise<void> {
    const fallback = this.previousSnapshot;
    if (fallback && fallback !== this.currentSnapshot && fs.existsSync(fallback)) {
      void vscode.window.showWarningMessage(
        `PDF load failed (${message}). Restoring previous snapshot.`,
      );
      this.currentSnapshot = fallback;
      const uri = this.panel!.webview.asWebviewUri(vscode.Uri.file(fallback));
      await this.panel!.webview.postMessage({ type: 'loadPdf', url: uri.toString() });
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
        if (this.currentSnapshot) {
          void this.showSnapshot(this.currentSnapshot);
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
