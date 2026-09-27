import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveToolchain, ToolchainError, type Toolchain } from './toolchain/discover';
import { runContextBuild } from './build/compiler';
import { gateJobArtifacts, type JobSnapshot } from './build/artifactGate';
import { forwardSync, backwardSync, SynctexError } from './synctex/mtxSynctex';
import { PdfPanel } from './viewer/pdfPanel';
import { resolveRootFile, type RootResolution } from './project/rootFile';
import { createDigestifClient, type DigestifClientHandle } from './lsp/digestifClient';
import { maybeOfferTexContextAssociation } from './project/texAssociation';

/** Bump when shipping a SyncTeX/viewer/LSP behavior change Sir must verify in Output. */
export const BUILD_ID = 'digestif-lsp-v9';

let output: vscode.OutputChannel;
let digestifOutput: vscode.OutputChannel;
let pdfPanel: PdfPanel;
let rootStatus: vscode.StatusBarItem;
let snapshot: JobSnapshot | undefined;
let generation = 0;
let building = false;
let lastRootResolution: RootResolution | undefined;
let backwardInFlight = false;
let digestif: DigestifClientHandle | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

function getToolchain(): Toolchain {
  return resolveToolchain();
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function activeTexPath(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    return undefined;
  }
  return ed.document.uri.fsPath;
}

function resolveCurrentRoot(activePath?: string): RootResolution | undefined {
  const active = activePath ?? activeTexPath() ?? lastRootResolution?.rootFile;
  if (!active) {
    return undefined;
  }
  let text = '';
  try {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === active);
    text = open ? open.getText() : fs.readFileSync(active, 'utf8');
  } catch {
    text = '';
  }
  const cfg = vscode.workspace.getConfiguration('context');
  const setting = cfg.get<string>('rootFile', '') ?? '';
  const resolved = resolveRootFile({
    activeFile: active,
    activeText: text,
    rootFileSetting: setting,
    workspaceFolders: workspaceFolderPaths(),
  });
  lastRootResolution = resolved;
  return resolved;
}

function updateRootStatus(): void {
  const r = resolveCurrentRoot();
  if (!r) {
    rootStatus.text = 'ConTeXt: (no root)';
    rootStatus.tooltip = 'Click to set context.rootFile';
    return;
  }
  const name = path.basename(r.rootFile);
  rootStatus.text = `ConTeXt: ${name}`;
  rootStatus.tooltip = `${r.rootFile}\nrule: ${r.rule}\nClick to change context.rootFile`;
}

async function pickRootFile(): Promise<void> {
  const current = resolveCurrentRoot();
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(file) Use active editor / auto-detect',
        description: 'Clear context.rootFile',
        value: '',
      },
      {
        label: '$(folder-opened) Choose main .tex…',
        description: 'Set context.rootFile for this workspace',
        value: '__browse__',
      },
      ...(current
        ? [
            {
              label: `$(check) Current: ${path.basename(current.rootFile)}`,
              description: current.rule,
              detail: current.rootFile,
              value: '__keep__',
            },
          ]
        : []),
    ],
    { title: 'ConTeXt main (root) file' },
  );
  if (!pick || pick.value === '__keep__') {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('context');
  if (pick.value === '') {
    await cfg.update('rootFile', '', vscode.ConfigurationTarget.Workspace);
    output.appendLine('[root] cleared context.rootFile (auto-detect)');
  } else {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { TeX: ['tex', 'ctx', 'mkiv', 'mkxl'] },
      defaultUri: current
        ? vscode.Uri.file(path.dirname(current.rootFile))
        : vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!uris?.[0]) {
      return;
    }
    const folders = workspaceFolderPaths();
    let rel = uris[0].fsPath;
    if (folders[0] && rel.startsWith(folders[0] + path.sep)) {
      rel = path.relative(folders[0], rel);
    }
    await cfg.update('rootFile', rel, vscode.ConfigurationTarget.Workspace);
    output.appendLine(`[root] set context.rootFile=${rel}`);
  }
  updateRootStatus();
}

async function buildAndPreview(): Promise<void> {
  if (building) {
    void vscode.window.showInformationMessage('A ConTeXt build is already running.');
    return;
  }

  const active = activeTexPath();
  const root = resolveCurrentRoot(active);
  if (!root) {
    void vscode.window.showErrorMessage('Open a ConTeXt / TeX source file to build.');
    return;
  }
  updateRootStatus();

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
  // DigestiF must never be awaited here. Reprint BUILD_ID after clear so Sir
  // can see which build is running even if DigestiF logs were wiped.
  output.appendLine(`ConTeXt SyncTeX BUILD_ID=${BUILD_ID} (build does not wait on DigestiF)`);
  output.appendLine(
    `Building root=${root.rootFile} (rule=${root.rule})` +
      (active && active !== root.rootFile ? `; active=${active}` : ''),
  );

  if (extensionContext) {
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === root.rootFile);
    void maybeOfferTexContextAssociation(
      extensionContext,
      root.rootFile,
      openDoc?.languageId,
      (line) => output.appendLine(line),
    );
  }

  try {
    const result = await runContextBuild(toolchain, root.rootFile, { output });
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
  const root = resolveCurrentRoot();
  if (!root) {
    void vscode.window.showErrorMessage('No PDF yet. Run ConTeXt: Build and Preview.');
    return;
  }
  if (extensionContext) {
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === root.rootFile);
    void maybeOfferTexContextAssociation(
      extensionContext,
      root.rootFile,
      openDoc?.languageId,
      (line) => output.appendLine(line),
    );
  }
  const pdfPath = root.rootFile.replace(/\.[^.]+$/, '.pdf');
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

  // Forward still uses the active file+line as --file (not the root).
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
      `[synctex find] page=${hit.page} llx=${hit.llx} lly=${hit.lly} urx=${hit.urx} ury=${hit.ury} (mtx y is top-down)`,
    );
    await pdfPanel.forwardSync(hit);
  } catch (err) {
    const msg = err instanceof SynctexError || err instanceof Error ? err.message : String(err);
    output.appendLine(`[synctex find] ${msg}`);
    void vscode.window.showWarningMessage(msg);
  }
}

async function handlePdfClick(
  page: number,
  x: number,
  y: number,
  meta?: { pdfY?: number; pageHeight?: number },
): Promise<void> {
  if (backwardInFlight) {
    output.appendLine('[synctex report] ignored duplicate click (in flight)');
    return;
  }
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

  backwardInFlight = true;
  // y is already mtx top-down from the viewer.
  output.appendLine(
    `[synctex report] page=${page} x=${x} y=${y}` +
      (meta?.pdfY != null ? ` pdfY=${meta.pdfY}` : '') +
      (meta?.pageHeight != null ? ` pageHeight=${meta.pageHeight}` : '') +
      ` synctex=${snapshot.synctexPath} jobDir=${snapshot.jobDir}`,
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
  } finally {
    backwardInFlight = false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  output = vscode.window.createOutputChannel('ConTeXt');
  // Separate channel so DigestiF stderr/LSP noise never interleaves with build logs.
  digestifOutput = vscode.window.createOutputChannel('ConTeXt DigestiF');

  rootStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  rootStatus.command = 'context.pickRootFile';
  rootStatus.show();

  pdfPanel = new PdfPanel(
    context.extensionUri,
    (page, x, y, meta) => {
      void handlePdfClick(page, x, y, meta);
    },
    (message) => {
      output.appendLine(message);
    },
  );

  digestif = createDigestifClient({
    output: digestifOutput,
    buildId: BUILD_ID,
  });

  context.subscriptions.push(
    output,
    digestifOutput,
    rootStatus,
    { dispose: () => pdfPanel.dispose() },
    { dispose: () => digestif?.dispose() },
    vscode.commands.registerCommand('context.buildAndPreview', () => {
      void buildAndPreview();
    }),
    vscode.commands.registerCommand('context.forwardSyncTeX', () => {
      void doForwardSync();
    }),
    vscode.commands.registerCommand('context.showPdf', () => {
      void showPdf();
    }),
    vscode.commands.registerCommand('context.pickRootFile', () => {
      void pickRootFile();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateRootStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('context.rootFile')) {
        updateRootStatus();
      }
      if (
        e.affectsConfiguration('context.root') ||
        e.affectsConfiguration('context.contextPath') ||
        e.affectsConfiguration('context.mtxrunPath') ||
        e.affectsConfiguration('context.digestif.enabled') ||
        e.affectsConfiguration('context.digestifPath')
      ) {
        digestif?.onSettingsChanged();
      }
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
  digestifOutput.appendLine(
    `ConTeXt DigestiF channel  BUILD_ID=${BUILD_ID} (build uses the ConTeXt channel only)`,
  );
  updateRootStatus();
  const r = lastRootResolution;
  if (r) {
    output.appendLine(`[root] ${r.rootFile} (rule=${r.rule})`);
  }
  digestif.scheduleStart();
  output.show(true);
}

export function deactivate(): void {
  void digestif?.stop();
  pdfPanel?.dispose();
}
