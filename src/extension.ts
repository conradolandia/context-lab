import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { BuildController } from './build/buildController';
import { PdfPanel } from './viewer/pdfPanel';
import {
  contextDocumentSelector,
  isContextLikeDocument,
} from './project/documentFilter';
import { createDigestifClient } from './lsp/digestifClient';
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
import { registerProjectManager } from './projectManager/projectManagerPanel';
import { refreshCommandKeywords } from './syntax/refreshKeywords';
import { maybeWarnLatexWorkshopConflict } from './compat/latexWorkshopConflict';
import { initOutputLog, logDebug, logUser } from './outputLog';
import { runtime } from './extension/state';
import {
  activeTexPath,
  buildFromProjectNode,
  getToolchain,
  pickRootFile,
  resolveCurrentRoot,
  setRootFromProjectNode,
  updateRootStatus,
  workspaceFolderPaths,
} from './extension/rootCommands';
import {
  afterSuccessfulBuild,
  maybeOpenExistingOnActivate,
  openPdfFromExplorer,
  revivePdfPanel,
  showPdf,
} from './extension/pdfCommands';
import {
  doForwardSync,
  forwardSyncFromProjectNode,
  handlePdfClick,
} from './extension/synctexCommands';
import { registerBuildModesUi } from './extension/buildModesCommands';

/** Bump when shipping a SyncTeX/viewer/LSP/diagnostics/project-view behavior change users must verify in Output. */
export const BUILD_ID = 'pdf-open-singleton';

export function activate(context: vscode.ExtensionContext): void {
  runtime.extensionContext = context;
  runtime.output = initOutputLog(context.subscriptions).user;
  runtime.digestifOutput = vscode.window.createOutputChannel('ConTeXt DigestiF');

  runtime.rootStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  runtime.rootStatus.command = 'context.pickRootFile';
  runtime.rootStatus.show();

  runtime.buildStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  runtime.buildStatus.show();

  registerBuildModesUi(context.subscriptions);

  runtime.buildDiagnostics = vscode.languages.createDiagnosticCollection('context.build');
  runtime.foldDiagnostics = vscode.languages.createDiagnosticCollection('context.folding');

  runtime.pdfPanel = new PdfPanel(
    context.extensionUri,
    (page, x, y, meta) => {
      void handlePdfClick(page, x, y, meta);
    },
    logDebug,
  );

  // Register before other work so reload can adopt restored panels (singleton).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PdfPanel.viewType, {
      deserializeWebviewPanel(panel, state) {
        PdfPanel.stashRestoredPanel(panel);
        return revivePdfPanel(panel, state);
      },
    }),
  );

  runtime.digestif = createDigestifClient({
    output: runtime.digestifOutput,
    buildId: BUILD_ID,
  });

  runtime.buildController = new BuildController({
    output: runtime.output,
    buildDiagnostics: runtime.buildDiagnostics,
    resolveToolchain: getToolchain,
    resolveRoot: resolveCurrentRoot,
    activeTexPath,
    buildId: BUILD_ID,
    buildStatus: runtime.buildStatus,
    onBuildStart: () => {
      runtime.pdfPanel.setBuilding(true, 'Building…');
      updateRootStatus();
      const root = runtime.lastRootResolution;
      if (runtime.extensionContext && root) {
        const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === root.rootFile);
        void maybeOfferTexContextAssociation(
          runtime.extensionContext,
          root.rootFile,
          openDoc?.languageId,
          logUser,
        );
      }
    },
    onBuildEnd: () => {
      runtime.pdfPanel.setBuilding(false);
    },
    onBuildSuccess: afterSuccessfulBuild,
  });

  const foldProvider = new ContextFoldingRangeProvider(runtime.foldDiagnostics);
  const linkProvider = new ContextDocumentLinkProvider();
  const figureHover = new ContextFigureHoverProvider();

  context.subscriptions.push(
    runtime.digestifOutput,
    runtime.rootStatus,
    runtime.buildStatus,
    runtime.buildDiagnostics,
    runtime.foldDiagnostics,
    { dispose: () => runtime.pdfPanel.dispose() },
    { dispose: () => runtime.digestif?.dispose() },
    { dispose: () => runtime.buildController?.dispose() },
    vscode.commands.registerCommand('context.buildAndPreview', () => {
      runtime.buildController?.requestCommandBuild();
    }),
    vscode.commands.registerCommand('context.cancelBuild', () => {
      runtime.buildController?.cancelBuild();
    }),
    vscode.commands.registerCommand('context.forwardSyncTeX', () => {
      void doForwardSync();
    }),
    vscode.commands.registerCommand('context.showPdf', () => {
      void showPdf();
    }),
    vscode.commands.registerCommand('context.openPdfInViewer', (uri?: vscode.Uri) => {
      void openPdfFromExplorer(uri);
    }),
    vscode.commands.registerCommand('context.pickRootFile', () => {
      void pickRootFile();
    }),
    vscode.commands.registerCommand('context.refreshKeywords', () => {
      void refreshCommandKeywords(context.extensionPath, runtime.output);
    }),
    vscode.languages.registerFoldingRangeProvider(contextDocumentSelector, foldProvider),
    vscode.languages.registerDocumentLinkProvider(contextDocumentSelector, linkProvider),
    vscode.languages.registerHoverProvider(contextDocumentSelector, figureHover),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateRootStatus();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isContextLikeDocument(doc)) {
        return;
      }
      const onSave = vscode.workspace.getConfiguration('context').get<boolean>('build.onSave', false);
      if (onSave) {
        runtime.buildController?.requestSaveBuild();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isContextLikeDocument(e.document)) {
        return;
      }
      publishFoldDiagnostics(e.document, runtime.foldDiagnostics);
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
        runtime.digestif?.onSettingsChanged();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!isContextLikeDocument(doc)) {
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
    output: runtime.output,
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
  runtime.digestifOutput.appendLine(
    `ConTeXt DigestiF channel  BUILD_ID=${BUILD_ID} (build uses the ConTeXt channel only)`,
  );
  updateRootStatus();
  const r = runtime.lastRootResolution;
  if (r) {
    logUser(`[root] ${r.rootFile} (rule=${r.rule})`);
  }
  runtime.digestif.scheduleStart();
  void maybeWarnLatexWorkshopConflict(context, logUser);
  void maybeOpenExistingOnActivate();
  runtime.output.show(true);
}

export function deactivate(): void {
  void runtime.digestif?.stop();
  runtime.pdfPanel?.dispose();
  runtime.buildController?.dispose();
}
