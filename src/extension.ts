import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveToolchain, ToolchainError, type Toolchain } from './toolchain/discover';
import type { BuildResult } from './build/compiler';
import { gateJobArtifacts, type JobSnapshot } from './build/artifactGate';
import {
  BuildController,
  preserveFocusForBuildTrigger,
  type BuildTrigger,
} from './build/buildController';
import {
  forwardSync,
  backwardSync,
  SynctexError,
  EMPTY_BACKWARD_USER_MESSAGE,
  COARSE_FLOAT_LINE_USER_MESSAGE,
} from './synctex/mtxSynctex';
import { PdfPanel } from './viewer/pdfPanel';
import { resolveRootFile, type RootResolution } from './project/rootFile';
import { createDigestifClient, type DigestifClientHandle } from './lsp/digestifClient';
import { maybeOfferTexContextAssociation } from './project/texAssociation';
import {
  ContextDocumentLinkProvider,
  ContextFigureHoverProvider,
} from './links/documentLinks';
import {
  ContextFoldingRangeProvider,
  publishFoldDiagnostics,
} from './folding/startStopFolding';
import { registerProjectView } from './project/projectTree';
import type { ProjectNode } from './project/projectModel';
import { registerProjectManager } from './projectManager/projectManagerPanel';
import { refreshCommandKeywords } from './syntax/refreshKeywords';
import { maybeWarnLatexWorkshopConflict } from './compat/latexWorkshopConflict';
import { initOutputLog, logDebug, logUser } from './outputLog';

/** Bump when shipping a SyncTeX/viewer/LSP/diagnostics/project-view behavior change Sir must verify in Output. */
export const BUILD_ID = 'synctex-viewer-crash-v1';

let output: vscode.OutputChannel;
let digestifOutput: vscode.OutputChannel;
let pdfPanel: PdfPanel;
let rootStatus: vscode.StatusBarItem;
let buildStatus: vscode.StatusBarItem;
let snapshot: JobSnapshot | undefined;
let generation = 0;
let lastRootResolution: RootResolution | undefined;
let backwardInFlight = false;
let digestif: DigestifClientHandle | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let buildController: BuildController | undefined;
let buildDiagnostics: vscode.DiagnosticCollection;
let foldDiagnostics: vscode.DiagnosticCollection;

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
    logUser('[root] cleared context.rootFile (auto-detect)');
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
    logUser(`[root] set context.rootFile=${rel}`);
  }
  updateRootStatus();
}

async function afterSuccessfulBuild(
  result: BuildResult,
  trigger: BuildTrigger,
): Promise<void> {
  generation += 1;
  try {
    snapshot = await gateJobArtifacts(result.pdfPath, generation);
  } catch (gateErr) {
    const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
    logUser(`[artifact gate] ${msg}`);
    void vscode.window.showErrorMessage(`Build succeeded but PDF gate failed: ${msg}`);
    return;
  }

  logDebug(
    `[gate] PDF → ${snapshot.pdfPath}` +
      (snapshot.synctexPath ? `; synctex → ${snapshot.synctexPath}` : '') +
      `; jobDir=${snapshot.jobDir}`,
  );
  // onSave / queued: always preserve editor focus. Manual command: omit opts so
  // showJobPdf preserves focus only when refreshing an already-open panel.
  await pdfPanel.showJobPdf(
    snapshot.pdfPath,
    snapshot.jobDir,
    preserveFocusForBuildTrigger(trigger) ? { preserveFocus: true } : undefined,
  );
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
      logUser,
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

async function doForwardSync(opts?: {
  file?: string;
  line?: number;
}): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('context');
  if (!cfg.get<boolean>('synctex.enabled', true)) {
    void vscode.window.showInformationMessage('SyncTeX is disabled (context.synctex.enabled).');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const file = opts?.file ?? editor?.document.uri.fsPath;
  if (!file) {
    void vscode.window.showErrorMessage('No active editor for Forward SyncTeX.');
    return;
  }

  let line = opts?.line;
  if (line == null) {
    if (editor && editor.document.uri.fsPath === file) {
      line = editor.selection.active.line + 1;
    } else {
      line = 1;
    }
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

  logDebug(
    `[synctex find] file=${file} line=${line} synctex=${snapshot.synctexPath} jobDir=${snapshot.jobDir}`,
  );

  try {
    const { result: hit, argv, cwd, note } = await forwardSync(
      toolchain,
      snapshot.synctexPath,
      file,
      line,
      snapshot.jobDir,
    );
    logDebug(`[synctex find] cwd=${cwd} argv=${JSON.stringify(argv)}`);
    logDebug(
      `[synctex find] page=${hit.page} llx=${hit.llx} lly=${hit.lly} urx=${hit.urx} ury=${hit.ury} (mtx y is top-down)`,
    );
    if (note) {
      logDebug(`[synctex find] ${note}`);
    }
    await pdfPanel.forwardSync(hit);
  } catch (err) {
    const msg = err instanceof SynctexError || err instanceof Error ? err.message : String(err);
    logDebug(`[synctex find] ${msg}`);
    void vscode.window.showWarningMessage(msg);
  }
}

function buildFromProjectNode(node: ProjectNode): void {
  if (node.kind === 'project') {
    const firstProduct = node.children.find((c) => c.kind === 'product' && c.fsPath && !c.missing);
    void vscode.window
      .showInformationMessage(
        'Project files are not compile targets (compiling a project can loop). Build a product instead.',
        firstProduct ? `Build ${firstProduct.label}` : 'OK',
      )
      .then((choice) => {
        if (firstProduct?.fsPath && choice?.startsWith('Build ')) {
          buildController?.requestCommandBuild(firstProduct.fsPath);
        }
      });
    return;
  }
  if (node.kind === 'environment') {
    void vscode.window.showInformationMessage(
      'Environment files are not compile targets. Build a product or component instead.',
    );
    return;
  }
  if (node.missing || !node.fsPath) {
    void vscode.window.showErrorMessage('Cannot build: file is missing or unresolved.');
    return;
  }

  if (node.kind === 'product' || node.kind === 'document') {
    buildController?.requestCommandBuild(node.fsPath);
    return;
  }

  // Component (and input): compile via resolveRootFile (product preferred).
  let text = '';
  try {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === node.fsPath);
    text = open ? open.getText() : fs.readFileSync(node.fsPath, 'utf8');
  } catch {
    text = '';
  }
  const cfg = vscode.workspace.getConfiguration('context');
  const resolved = resolveRootFile({
    activeFile: node.fsPath,
    activeText: text,
    rootFileSetting: cfg.get<string>('rootFile', '') ?? '',
    workspaceFolders: workspaceFolderPaths(),
  });
  buildController?.requestCommandBuild(resolved.rootFile);
}

async function forwardSyncFromProjectNode(node: ProjectNode): Promise<void> {
  if (!node.fsPath || node.missing) {
    void vscode.window.showErrorMessage('Cannot SyncTeX: file is missing or unresolved.');
    return;
  }
  const openEditor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.fsPath === node.fsPath,
  );
  const line = openEditor ? openEditor.selection.active.line + 1 : 1;
  await doForwardSync({ file: node.fsPath, line });
}

async function setRootFromProjectNode(node: ProjectNode): Promise<void> {
  if (!node.fsPath || node.missing) {
    void vscode.window.showErrorMessage('Cannot set root: file is missing or unresolved.');
    return;
  }
  const folders = workspaceFolderPaths();
  let rel = node.fsPath;
  if (folders[0] && rel.startsWith(folders[0] + path.sep)) {
    rel = path.relative(folders[0], rel);
  }
  const cfg = vscode.workspace.getConfiguration('context');
  await cfg.update('rootFile', rel, vscode.ConfigurationTarget.Workspace);
  logUser(`[root] set context.rootFile=${rel} (from Project view)`);
  updateRootStatus();
}

async function handlePdfClick(
  page: number,
  x: number,
  y: number,
  meta?: { pdfY?: number; pageHeight?: number },
): Promise<void> {
  if (backwardInFlight) {
    logDebug('[synctex report] ignored duplicate click (in flight)');
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
  logDebug(
    `[synctex report] page=${page} x=${x} y=${y}` +
      (meta?.pdfY != null ? ` pdfY=${meta.pdfY}` : '') +
      (meta?.pageHeight != null ? ` pageHeight=${meta.pageHeight}` : '') +
      ` synctex=${snapshot.synctexPath} jobDir=${snapshot.jobDir}`,
  );

  try {
    const { result: hit, argv, cwd, note } = await backwardSync(
      toolchain,
      snapshot.synctexPath,
      page,
      x,
      y,
      snapshot.jobDir,
    );
    logDebug(`[synctex report] cwd=${cwd} argv=${JSON.stringify(argv)}`);
    logDebug(
      `[synctex report] file=${hit.filename} line=${hit.linenumber} tol=${hit.tolerance}` +
        (hit.refined ? ' refined=1' : '') +
        (hit.coarseFloatLine ? ' coarseFloatLine=1' : ''),
    );
    if (note) {
      logDebug(`[synctex report] ${note}`);
    }

    // Coarse float/caption tags (line ≤ 1 mid-page) are not useful navigation
    // targets — message only, same class of outcome as an empty image click.
    if (hit.coarseFloatLine) {
      void vscode.window.showInformationMessage(COARSE_FLOAT_LINE_USER_MESSAGE);
      return;
    }

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
    logDebug(`[synctex report] ${msg}`);
    if (err instanceof SynctexError && err.kind === 'empty') {
      void vscode.window.showWarningMessage(EMPTY_BACKWARD_USER_MESSAGE);
    } else {
      void vscode.window.showWarningMessage(msg);
    }
  } finally {
    backwardInFlight = false;
  }
}

function isContextLike(doc: vscode.TextDocument): boolean {
  return (
    doc.languageId === 'context' ||
    doc.languageId === 'tex' ||
    doc.languageId === 'latex' ||
    /\.(tex|mkiv|mkxl|mkvi|mklx|mkii|ctx)$/i.test(doc.uri.fsPath)
  );
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  output = initOutputLog(context.subscriptions).user;
  digestifOutput = vscode.window.createOutputChannel('ConTeXt DigestiF');

  rootStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  rootStatus.command = 'context.pickRootFile';
  rootStatus.show();

  buildStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  buildStatus.show();

  buildDiagnostics = vscode.languages.createDiagnosticCollection('context.build');
  foldDiagnostics = vscode.languages.createDiagnosticCollection('context.folding');

  pdfPanel = new PdfPanel(
    context.extensionUri,
    (page, x, y, meta) => {
      void handlePdfClick(page, x, y, meta);
    },
    logDebug,
  );

  digestif = createDigestifClient({
    output: digestifOutput,
    buildId: BUILD_ID,
  });

  buildController = new BuildController({
    output,
    buildDiagnostics,
    resolveToolchain: getToolchain,
    resolveRoot: resolveCurrentRoot,
    activeTexPath,
    buildId: BUILD_ID,
    buildStatus,
    onBuildStart: () => {
      pdfPanel.setBuilding(true, 'Building…');
      updateRootStatus();
      const root = lastRootResolution;
      if (extensionContext && root) {
        const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === root.rootFile);
        void maybeOfferTexContextAssociation(
          extensionContext,
          root.rootFile,
          openDoc?.languageId,
          logUser,
        );
      }
    },
    onBuildEnd: () => {
      pdfPanel.setBuilding(false);
    },
    onBuildSuccess: afterSuccessfulBuild,
  });

  const foldProvider = new ContextFoldingRangeProvider(foldDiagnostics);
  const linkProvider = new ContextDocumentLinkProvider();
  const figureHover = new ContextFigureHoverProvider();
  const contextSelector: vscode.DocumentSelector = [
    { language: 'context' },
    { language: 'tex' },
    { pattern: '**/*.{mkiv,mkxl,mkvi,mklx,mkii,tex,ctx}' },
  ];

  context.subscriptions.push(
    digestifOutput,
    rootStatus,
    buildStatus,
    buildDiagnostics,
    foldDiagnostics,
    { dispose: () => pdfPanel.dispose() },
    { dispose: () => digestif?.dispose() },
    { dispose: () => buildController?.dispose() },
    vscode.commands.registerCommand('context.buildAndPreview', () => {
      buildController?.requestCommandBuild();
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
    vscode.commands.registerCommand('context.refreshKeywords', () => {
      void refreshCommandKeywords(context.extensionPath, output);
    }),
    vscode.languages.registerFoldingRangeProvider(contextSelector, foldProvider),
    vscode.languages.registerDocumentLinkProvider(contextSelector, linkProvider),
    vscode.languages.registerHoverProvider(contextSelector, figureHover),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateRootStatus();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isContextLike(doc)) {
        return;
      }
      const onSave = vscode.workspace.getConfiguration('context').get<boolean>('build.onSave', false);
      if (onSave) {
        buildController?.requestSaveBuild();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isContextLike(e.document)) {
        return;
      }
      publishFoldDiagnostics(e.document, foldDiagnostics);
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
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!isContextLike(doc)) {
        return;
      }
      void maybeWarnLatexWorkshopConflict(context, logUser);
    }),
  );

  const projectView = registerProjectView(context, {
    workspaceFolderPaths,
    activeTexPath,
    getRootFileSetting: () =>
      vscode.workspace.getConfiguration('context').get<string>('rootFile', '') ?? '',
    buildNode: buildFromProjectNode,
    forwardSyncNode: (node) => {
      void forwardSyncFromProjectNode(node);
    },
    setRootFromNode: setRootFromProjectNode,
  });

  registerProjectManager(context, {
    output,
    refreshProjectView: () => projectView.refresh(),
  });

  const pkgPath = path.join(context.extensionPath, 'package.json');
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    version = pkg.version ?? version;
  } catch {
    // keep unknown
  }
  logUser(`ConTeXt Tools activated  version=${version}  BUILD_ID=${BUILD_ID}`);
  logDebug(`extensionPath=${context.extensionPath}`);
  digestifOutput.appendLine(
    `ConTeXt DigestiF channel  BUILD_ID=${BUILD_ID} (build uses the ConTeXt channel only)`,
  );
  updateRootStatus();
  const r = lastRootResolution;
  if (r) {
    logUser(`[root] ${r.rootFile} (rule=${r.rule})`);
  }
  digestif.scheduleStart();
  void maybeWarnLatexWorkshopConflict(context, logUser);
  output.show(true);
}

export function deactivate(): void {
  void digestif?.stop();
  pdfPanel?.dispose();
  buildController?.dispose();
}
