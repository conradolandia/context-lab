import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveToolchain, ToolchainError, type Toolchain } from './toolchain/discover';
import { runContextBuild } from './build/compiler';
import { gateJobArtifacts, type JobSnapshot } from './build/artifactGate';
import { forwardSync, backwardSync, SynctexError } from './synctex/mtxSynctex';
import { PdfPanel } from './viewer/pdfPanel';

/** Bump when shipping a SyncTeX/viewer behavior change Sir must verify in Output. */
export const BUILD_ID = 'synctex-report-v3';

let output: vscode.OutputChannel;
let pdfPanel: PdfPanel;
let snapshot: JobSnapshot | undefined;
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
  return ed.document.uri.fsPath;
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
  // Keep last good view; do not tear down or reload mid-compile.
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
      return;
    }

    generation += 1;
    try {
      snapshot = await gateJobArtifacts(result.pdfPath, generation);
    } catch (gateErr) {
      const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
      output.appendLine(`[artifact gate] ${msg}`);
      void vscode.window.showErrorMessage(`Build succeeded but PDF gate failed: ${msg}`);
      return;
    }

    output.appendLine(
      `[gate] PDF → ${snapshot.pdfPath}` +
        (snapshot.synctexPath ? `; synctex → ${snapshot.synctexPath}` : '') +
        `; jobDir=${snapshot.jobDir}`,
    );
    await pdfPanel.showJobPdf(snapshot.pdfPath, snapshot.jobDir);
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
    await pdfPanel.showJobPdf(snapshot.pdfPath, snapshot.jobDir);
    return;
  }
  const sourcePath = activeTexPath() ?? lastSourcePath;
  if (!sourcePath) {
    void vscode.window.showErrorMessage('No PDF yet. Run ConTeXt: Build and Preview.');
    return;
  }
  const pdfPath = sourcePath.replace(/\.[^.]+$/, '.pdf');
  if (!fs.existsSync(pdfPath)) {
    void vscode.window.showErrorMessage(`No PDF found at ${pdfPath}. Build first.`);
    return;
  }
  generation += 1;
  try {
    snapshot = await gateJobArtifacts(pdfPath, generation);
    await pdfPanel.showJobPdf(snapshot.pdfPath, snapshot.jobDir);
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

  if (!snapshot?.synctexPath || !snapshot.pdfPath || !snapshot.jobDir) {
    void vscode.window.showErrorMessage(
      'No SyncTeX data yet. Run ConTeXt: Build and Preview first.',
    );
    return;
  }

  let toolchain: Toolchain;
  try {
    toolchain = getToolchain();
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    return;
  }

  const file = editor.document.uri.fsPath;
  const line = editor.selection.active.line + 1;
  output.appendLine(
    `[synctex find] file=${file} line=${line} synctex=${snapshot.synctexPath} jobDir=${snapshot.jobDir}`,
  );

  try {
    const { result: hit, argv, cwd } = await forwardSync(
      toolchain,
      snapshot.synctexPath,
      file,
      line,
      snapshot.jobDir,
    );
    output.appendLine(`[synctex find] cwd=${cwd} argv=${JSON.stringify(argv)}`);
    output.appendLine(
      `[synctex find] page=${hit.page} llx=${hit.llx} lly=${hit.lly} urx=${hit.urx} ury=${hit.ury}`,
    );
    await pdfPanel.showJobPdf(snapshot.pdfPath, snapshot.jobDir);
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
  if (!snapshot?.synctexPath || !snapshot.jobDir) {
    void vscode.window.showWarningMessage('No SyncTeX data for backward search.');
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
    `[synctex report] page=${page} x=${x} y=${y} synctex=${snapshot.synctexPath} jobDir=${snapshot.jobDir}`,
  );

  try {
    const { result: hit, argv, cwd } = await backwardSync(
      toolchain,
      snapshot.synctexPath,
      page,
      x,
      y,
      snapshot.jobDir,
    );
    output.appendLine(`[synctex report] cwd=${cwd} argv=${JSON.stringify(argv)}`);
    output.appendLine(
      `[synctex report] file=${hit.filename} line=${hit.linenumber} tol=${hit.tolerance}`,
    );

    let targetPath = hit.filename;
    if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(snapshot.jobDir, targetPath);
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

  pdfPanel = new PdfPanel(
    context.extensionUri,
    (page, x, y) => {
      void handlePdfClick(page, x, y);
    },
    (message) => {
      output.appendLine(message);
    },
  );

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

  const pkgPath = path.join(context.extensionPath, 'package.json');
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    version = pkg.version ?? version;
  } catch {
    // keep unknown
  }
  output.appendLine(
    `ConTeXt SyncTeX activated  version=${version}  BUILD_ID=${BUILD_ID}`,
  );
  output.appendLine(`extensionPath=${context.extensionPath}`);
  output.show(true);
}

export function deactivate(): void {
  // nothing
}
