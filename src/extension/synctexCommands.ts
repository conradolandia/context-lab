import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Toolchain } from '../toolchain/discover';
import {
  forwardSync,
  backwardSync,
  SynctexError,
  EMPTY_BACKWARD_USER_MESSAGE,
  COARSE_FLOAT_LINE_USER_MESSAGE,
} from '../synctex/mtxSynctex';
import type { ProjectNode } from '../project/projectModel';
import { logDebug } from '../outputLog';
import { getToolchain } from './rootCommands';
import { runtime } from './state';

export async function doForwardSync(opts?: {
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

  if (!runtime.snapshot?.synctexPath || !runtime.snapshot.pdfPath || !runtime.snapshot.jobDir) {
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
    `[synctex find] file=${file} line=${line} synctex=${runtime.snapshot.synctexPath} jobDir=${runtime.snapshot.jobDir}`,
  );

  try {
    const {
      result: hit,
      raw,
      diag,
      extraHits,
      argv,
      cwd,
      stdout,
      stderr,
      note,
    } = await forwardSync(
      toolchain,
      runtime.snapshot.synctexPath,
      file,
      line,
      runtime.snapshot.jobDir,
    );
    logDebug(`[synctex find] cwd=${cwd} argv=${JSON.stringify(argv)}`);
    const mtxOut = `${stdout}\n${stderr}`.trim();
    if (mtxOut) {
      logDebug(`[synctex find] mtx stdout/stderr:\n${mtxOut}`);
    }
    logDebug(
      `[synctex find] raw mtx page=${raw.page} llx=${raw.llx} lly=${raw.lly} urx=${raw.urx} ury=${raw.ury}` +
        ` w=${(raw.urx - raw.llx).toFixed(2)} h=${Math.abs(raw.ury - raw.lly).toFixed(2)}` +
        ` cyTopDown=${((raw.lly + raw.ury) / 2).toFixed(2)} (mtx --find y is SyncTeX top-down)`,
    );
    if (extraHits.length > 0) {
      logDebug(
        `[synctex find] extra mtx hits (${extraHits.length}): ` +
          extraHits
            .map(
              (h) =>
                `page=${h.page} llx=${h.llx} lly=${h.lly} urx=${h.urx} ury=${h.ury}`,
            )
            .join(' | '),
      );
    }
    logDebug(
      `[synctex find] refine action=${diag.action} hitInEdge=${diag.hitInEdge}` +
        ` skipHighlight=${diag.skipHighlight}` +
        ` unitScale=${diag.unitScale ?? 'null'}` +
        ` pageH=${diag.pageHeight.toFixed(1)} pageW=${diag.pageWidth.toFixed(1)}` +
        ` band=${diag.band.toFixed(1)} sameLine=${diag.sameLineCount}` +
        ` hitCyTopDown=${diag.hitCy.toFixed(2)}`,
    );
    if (diag.sameLineBoxes.length > 0) {
      const maxDump = 12;
      const dump = diag.sameLineBoxes.slice(0, maxDump).map((b) => {
        const flags =
          (b.inEdge ? 'E' : '-') + (b.oversized ? 'O' : '-');
        return (
          `[${flags}] x=${b.x.toFixed(1)} y=${b.y.toFixed(1)}` +
          ` w=${b.w.toFixed(1)} h=${b.h.toFixed(1)} d=${b.d.toFixed(1)}` +
          ` cy=${b.cy.toFixed(1)} area=${b.area.toFixed(0)}`
        );
      });
      logDebug(
        `[synctex find] same-line boxes (E=edge O=oversized` +
          (diag.sameLineBoxes.length > maxDump
            ? `; showing ${maxDump}/${diag.sameLineBoxes.length}`
            : '') +
          `):\n  ${dump.join('\n  ')}`,
      );
    }
    logDebug(
      `[synctex find] chosen page=${hit.page} llx=${hit.llx} lly=${hit.lly} urx=${hit.urx} ury=${hit.ury}` +
        ` w=${(hit.urx - hit.llx).toFixed(2)} h=${Math.abs(hit.ury - hit.lly).toFixed(2)}` +
        (diag.skipHighlight ? ' (skip paint)' : ''),
    );
    if (note) {
      logDebug(`[synctex find] ${note}`);
    }
    await runtime.pdfPanel.forwardSync({
      ...hit,
      synctexPageH: diag.pageHeight > 0 ? diag.pageHeight : undefined,
      synctexPageW: diag.pageWidth > 0 ? diag.pageWidth : undefined,
      skipHighlight: diag.skipHighlight,
    });
  } catch (err) {
    const msg = err instanceof SynctexError || err instanceof Error ? err.message : String(err);
    logDebug(`[synctex find] ${msg}`);
    void vscode.window.showWarningMessage(msg);
  }
}

export async function forwardSyncFromProjectNode(node: ProjectNode): Promise<void> {
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

export async function handlePdfClick(
  page: number,
  x: number,
  y: number,
  meta?: { pdfY?: number; pageHeight?: number },
): Promise<void> {
  if (runtime.backwardInFlight) {
    logDebug('[synctex report] ignored duplicate click (in flight)');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('context');
  if (!cfg.get<boolean>('synctex.enabled', true)) {
    return;
  }
  if (!runtime.snapshot?.synctexPath || !runtime.snapshot.jobDir) {
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

  runtime.backwardInFlight = true;
  logDebug(
    `[synctex report] page=${page} x=${x} y=${y}` +
      (meta?.pdfY != null ? ` pdfY=${meta.pdfY}` : '') +
      (meta?.pageHeight != null ? ` pageHeight=${meta.pageHeight}` : '') +
      ` synctex=${runtime.snapshot.synctexPath} jobDir=${runtime.snapshot.jobDir}`,
  );

  try {
    const { result: hit, argv, cwd, note } = await backwardSync(
      toolchain,
      runtime.snapshot.synctexPath,
      page,
      x,
      y,
      runtime.snapshot.jobDir,
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

    // Coarse float/caption tags (line ≤ 1 mid-page after aggressive refine):
    // still open the editor at the reported line; soft info once.
    if (hit.coarseFloatLine) {
      void vscode.window.showInformationMessage(COARSE_FLOAT_LINE_USER_MESSAGE);
    }

    let targetPath = hit.filename;
    if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(runtime.snapshot.jobDir, targetPath);
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
    runtime.backwardInFlight = false;
  }
}
