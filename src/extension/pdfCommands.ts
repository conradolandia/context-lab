import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BuildResult } from '../build/compiler';
import {
  findSynctexSibling,
  gateJobArtifacts,
  isConTeXtPreviewPdf,
  type JobSnapshot,
} from '../build/artifactGate';
import {
  preserveFocusForBuildTrigger,
  type BuildTrigger,
} from '../build/buildController';
import type { PdfPanelState } from '../viewer/pdfPanel';
import { maybeOfferTexContextAssociation } from '../project/texAssociation';
import { logDebug, logUser } from '../outputLog';
import { resolveCurrentRoot } from './rootCommands';
import { LAST_GATED_PDF_STATE_KEY, runtime } from './state';

function rootPdfPath(rootFile: string): string {
  return rootFile.replace(/\.[^.]+$/, '.pdf');
}

function relatedJobPdfPaths(): Array<string | undefined> {
  const root = resolveCurrentRoot();
  return [runtime.snapshot?.pdfPath, root ? rootPdfPath(root.rootFile) : undefined];
}

async function rememberGatedPdf(snap: JobSnapshot): Promise<void> {
  if (!runtime.extensionContext) {
    return;
  }
  await runtime.extensionContext.workspaceState.update(LAST_GATED_PDF_STATE_KEY, {
    pdfPath: snap.pdfPath,
    jobDir: snap.jobDir,
  } satisfies PdfPanelState);
}

async function openGatedPdf(
  pdfPath: string,
  opts?: { preserveFocus?: boolean },
): Promise<boolean> {
  runtime.generation += 1;
  try {
    runtime.snapshot = await gateJobArtifacts(pdfPath, runtime.generation);
    await rememberGatedPdf(runtime.snapshot);
    await runtime.pdfPanel.showJobPdf(runtime.snapshot.pdfPath, runtime.snapshot.jobDir, opts);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUser(`[artifact gate] ${msg}`);
    void vscode.window.showErrorMessage(msg);
    return false;
  }
}

export async function afterSuccessfulBuild(
  result: BuildResult,
  trigger: BuildTrigger,
): Promise<void> {
  runtime.generation += 1;
  try {
    runtime.snapshot = await gateJobArtifacts(result.pdfPath, runtime.generation);
  } catch (gateErr) {
    const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
    logUser(`[artifact gate] ${msg}`);
    void vscode.window.showErrorMessage(`Build succeeded but PDF gate failed: ${msg}`);
    return;
  }

  logDebug(
    `[gate] PDF → ${runtime.snapshot.pdfPath}` +
      (runtime.snapshot.synctexPath ? `; synctex → ${runtime.snapshot.synctexPath}` : '') +
      `; jobDir=${runtime.snapshot.jobDir}`,
  );
  await rememberGatedPdf(runtime.snapshot);
  // onSave / queued: always preserve editor focus. Manual command: omit opts so
  // showJobPdf preserves focus only when refreshing an already-open panel.
  await runtime.pdfPanel.showJobPdf(
    runtime.snapshot.pdfPath,
    runtime.snapshot.jobDir,
    preserveFocusForBuildTrigger(trigger) ? { preserveFocus: true } : undefined,
  );
}

/**
 * Open an existing job PDF in the ConTeXt viewer (no rebuild).
 * Uses the last gated snapshot when present; otherwise gates the root PDF.
 */
export async function showPdf(): Promise<void> {
  if (runtime.snapshot?.pdfPath && fs.existsSync(runtime.snapshot.pdfPath)) {
    await runtime.pdfPanel.showJobPdf(runtime.snapshot.pdfPath, runtime.snapshot.jobDir);
    return;
  }
  const root = resolveCurrentRoot();
  if (!root) {
    void vscode.window.showErrorMessage(
      'No ConTeXt root PDF yet. Set the main file or run ConTeXt: Build and Preview.',
    );
    return;
  }
  if (runtime.extensionContext) {
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === root.rootFile);
    void maybeOfferTexContextAssociation(
      runtime.extensionContext,
      root.rootFile,
      openDoc?.languageId,
      logUser,
    );
  }
  const pdfPath = rootPdfPath(root.rootFile);
  if (!fs.existsSync(pdfPath)) {
    void vscode.window.showErrorMessage(
      `No PDF at ${pdfPath}. Run ConTeXt: Build and Preview, or open an existing job PDF from the Explorer.`,
    );
    return;
  }
  await openGatedPdf(pdfPath);
}

/** Explorer: open a .pdf in the ConTeXt viewer when it looks like a job artifact. */
export async function openPdfFromExplorer(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file' || !/\.pdf$/i.test(target.fsPath)) {
    void vscode.window.showErrorMessage('Select a PDF file in the Explorer.');
    return;
  }
  const pdfPath = target.fsPath;
  if (!isConTeXtPreviewPdf(pdfPath, relatedJobPdfPaths())) {
    void vscode.window.showInformationMessage(
      'Not a ConTeXt job PDF (no sibling .synctex and not the active root output). Use a default PDF editor, or build with SyncTeX first.',
    );
    return;
  }
  if (
    runtime.snapshot?.pdfPath &&
    path.resolve(runtime.snapshot.pdfPath) === path.resolve(pdfPath)
  ) {
    await runtime.pdfPanel.showJobPdf(runtime.snapshot.pdfPath, runtime.snapshot.jobDir);
    return;
  }
  await openGatedPdf(pdfPath);
}

/**
 * Optional one-shot open when artifacts already exist (setting default false).
 * Prefer command palette / Explorer menu when auto-open is undesirable.
 * Requires PDF + sibling SyncTeX so the artifact gate can pair them.
 */
export async function maybeOpenExistingOnActivate(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('context');
  if (!cfg.get<boolean>('viewer.openExistingOnActivate', false)) {
    return;
  }
  if (runtime.snapshot?.pdfPath && fs.existsSync(runtime.snapshot.pdfPath)) {
    await runtime.pdfPanel.showJobPdf(runtime.snapshot.pdfPath, runtime.snapshot.jobDir, {
      preserveFocus: true,
    });
    logUser('[viewer] openExistingOnActivate: reused gated snapshot');
    return;
  }
  const root = resolveCurrentRoot();
  if (!root) {
    return;
  }
  const pdfPath = rootPdfPath(root.rootFile);
  if (!fs.existsSync(pdfPath) || !findSynctexSibling(pdfPath)) {
    return;
  }
  const ok = await openGatedPdf(pdfPath, { preserveFocus: true });
  if (ok) {
    logUser('[viewer] openExistingOnActivate: gated existing PDF');
  }
}

export async function revivePdfPanel(
  panel: vscode.WebviewPanel,
  state: unknown,
): Promise<void> {
  runtime.pdfPanel.adoptPanel(panel);
  const fromState = (state ?? {}) as PdfPanelState;
  const remembered =
    runtime.extensionContext?.workspaceState.get<PdfPanelState>(LAST_GATED_PDF_STATE_KEY);
  const candidates = [fromState.pdfPath, runtime.snapshot?.pdfPath, remembered?.pdfPath];
  const pdfPath = candidates.find((p) => p && fs.existsSync(p));
  if (!pdfPath) {
    logDebug('[viewer] serializer adopted panel (no PDF path to restore)');
    return;
  }
  if (
    runtime.snapshot?.pdfPath &&
    path.resolve(runtime.snapshot.pdfPath) === path.resolve(pdfPath)
  ) {
    await runtime.pdfPanel.showJobPdf(runtime.snapshot.pdfPath, runtime.snapshot.jobDir, {
      preserveFocus: true,
    });
    return;
  }
  await openGatedPdf(pdfPath, { preserveFocus: true });
}
