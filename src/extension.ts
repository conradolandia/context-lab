import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveToolchain, ToolchainError, type Toolchain } from './toolchain/discover';
import { runContextBuild } from './build/compiler';
import { gateAndCopy, type CacheSnapshot } from './build/artifactGate';
import { forwardSync, backwardSync, SynctexError } from './synctex/mtxSynctex';
import { PdfPanel } from './viewer/pdfPanel';

let output: vscode.OutputChannel;
let pdfPanel: PdfPanel;
let cacheDir: string;
let snapshot: CacheSnapshot | undefined;
let generation = 0;
let building = false;
let lastSourcePath: string | undefined;

function getToolchain(): Toolchain {
  return resolveToolchain();
}

function activeTexPath(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    return undefined;
  }
  const fsPath = ed.document.uri.fsPath;
  if (!/\.(tex|ctx|mkiv|mkxl)$/i.test(fsPath) && ed.document.languageId !== 'context') {
    // Still allow if user explicitly builds from any file with ConTeXt commands
  }
  return fsPath;
}

async function buildAndPreview(): Promise<void> {
  if (building) {
    void vscode.window.showInformationMessage('A ConTeXt build is already running.');
    return;
  }

  const sourcePath = activeTexPath() ?? lastSourcePath;
  if (!sourcePath) {
    void vscode.window.showErrorMessage('Open a ConTeXt / TeX source file to build.');
    return;
  }
  lastSourcePath = sourcePath;

  let toolchain: Toolchain;
  try {
    toolchain = getToolchain();
  } catch (err) {
    const msg = err instanceof ToolchainError ? err.message : String(err);
    void vscode.window.showErrorMessage(msg);
    output.appendLine(msg);
    return;
  }

  building = true;
  pdfPanel.setBuilding(true, 'Building…');
  output.clear();
  output.show(true);
  output.appendLine(`Building ${sourcePath}`);

  try {
    const result = await runContextBuild(toolchain, sourcePath, { output });
    if (result.exitCode !== 0) {
      void vscode.window.showErrorMessage(
        `ConTeXt build failed (exit ${result.exitCode}). See ConTeXt output.`,
      );
      // Keep last good view — do not refresh viewer
      return;
    }

    generation += 1;
    try {
      snapshot = await gateAndCopy(result.pdfPath, cacheDir, generation);
    } catch (gateErr) {
      const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
      output.appendLine(`[artifact gate] ${msg}`);
      void vscode.window.showErrorMessage(`Build succeeded but PDF gate failed: ${msg}`);
      return;
    }

    output.appendLine(
      `[cache] PDF → ${snapshot.pdfPath}` +
        (snapshot.synctexPath ? `; synctex → ${snapshot.synctexPath}` : ''),
    );
    await pdfPanel.showSnapshot(snapshot.pdfPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(msg);
    void vscode.window.showErrorMessage(`Build error: ${msg}`);
  } finally {
    building = false;
    pdfPanel.setBuilding(false);
  }
}

async function showPdf(): Promise<void> {
  if (snapshot?.pdfPath && fs.existsSync(snapshot.pdfPath)) {
    await pdfPanel.showSnapshot(snapshot.pdfPath);
    return;
  }
  // Fall back to sibling PDF of last/active source without rebuilding
  const sourcePath = activeTexPath() ?? lastSourcePath;
  if (!sourcePath) {
    void vscode.window.showErrorMessage('No PDF snapshot yet. Run ConTeXt: Build and Preview.');
    return;
  }
  const pdfPath = sourcePath.replace(/\.[^.]+$/, '.pdf');
  if (!fs.existsSync(pdfPath)) {
    void vscode.window.showErrorMessage(`No PDF found at ${pdfPath}. Build first.`);
    return;
  }
  void vscode.window.showWarningMessage(
    'Showing job PDF without a gated cache snapshot. Prefer Build and Preview for SyncTeX safety.',
  );
  generation += 1;
  try {
    snapshot = await gateAndCopy(pdfPath, cacheDir, generation);
    await pdfPanel.showSnapshot(snapshot.pdfPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(msg);
  }
}

async function doForwardSync(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('context');
  if (!cfg.get<boolean>('synctex.enabled', true)) {
    void vscode.window.showInformationMessage('SyncTeX is disabled (context.synctex.enabled).');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showErrorMessage('No active editor for Forward SyncTeX.');
    return;
  }

  if (!snapshot?.synctexPath || !snapshot.pdfPath) {
    void vscode.window.showErrorMessage(
      'No frozen SyncTeX snapshot. Run ConTeXt: Build and Preview first.',
    );
    return;
  }

  // During build, keep using the previous published snapshot pair (already frozen).
  let toolchain: Toolchain;
  try {
    toolchain = getToolchain();
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    return;
  }

  const file = editor.document.uri.fsPath;
  const line = editor.selection.active.line + 1;
  output.appendLine(`[synctex find] file=${file} line=${line} snap=${snapshot.synctexPath}`);

  try {
    const hit = await forwardSync(
      toolchain,
      snapshot.synctexPath,
      file,
      line,
      path.dirname(snapshot.synctexPath),
    );
    output.appendLine(
      `[synctex find] page=${hit.page} llx=${hit.llx} lly=${hit.lly} urx=${hit.urx} ury=${hit.ury}`,
    );
    await pdfPanel.showSnapshot(snapshot.pdfPath);
    await pdfPanel.forwardSync(hit);
  } catch (err) {
    const msg = err instanceof SynctexError || err instanceof Error ? err.message : String(err);
    output.appendLine(`[synctex find] ${msg}`);
    void vscode.window.showWarningMessage(msg);
  }
}

async function handlePdfClick(page: number, x: number, y: number): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('context');
  if (!cfg.get<boolean>('synctex.enabled', true)) {
    return;
  }
  if (!snapshot?.synctexPath) {
    void vscode.window.showWarningMessage('No SyncTeX snapshot for backward search.');
    return;
  }

  let toolchain: Toolchain;
  try {
    toolchain = getToolchain();
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    return;
  }

  output.appendLine(
    `[synctex report] page=${page} x=${x} y=${y} snap=${snapshot.synctexPath}`,
  );

  try {
    const hit = await backwardSync(
      toolchain,
      snapshot.synctexPath,
      page,
      x,
      y,
      path.dirname(snapshot.synctexPath),
    );
    output.appendLine(
      `[synctex report] file=${hit.filename} line=${hit.linenumber} tol=${hit.tolerance}`,
    );

    let targetPath = hit.filename;
    if (!path.isAbsolute(targetPath)) {
      const base = lastSourcePath ? path.dirname(lastSourcePath) : path.dirname(snapshot.synctexPath);
      targetPath = path.resolve(base, targetPath);
    }
    const uri = vscode.Uri.file(targetPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const line = Math.max(0, hit.linenumber - 1);
    const range = new vscode.Range(line, 0, line, 0);
    ed.selection = new vscode.Selection(range.start, range.start);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`[synctex report] ${msg}`);
    void vscode.window.showWarningMessage(msg);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('ConTeXt');
  cacheDir = path.join(context.globalStorageUri.fsPath, 'pdf-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  pdfPanel = new PdfPanel(context.extensionUri, context.globalStorageUri, (page, x, y) => {
    void handlePdfClick(page, x, y);
  });

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('context.buildAndPreview', () => {
      void buildAndPreview();
    }),
    vscode.commands.registerCommand('context.forwardSyncTeX', () => {
      void doForwardSync();
    }),
    vscode.commands.registerCommand('context.showPdf', () => {
      void showPdf();
    }),
  );

  output.appendLine('ConTeXt SyncTeX extension activated.');
}

export function deactivate(): void {
  // nothing
}
