/**
 * Apply a StructurePlan via WorkspaceEdit; set context.rootFile only
 * (never inject % !TEX root); open root; refresh Project view; offer *.tex association.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { StructurePlan } from './structurePlan';
import { maybeOfferTexContextAssociation } from '../project/texAssociation';

export interface ApplyPlanOptions {
  plan: StructurePlan;
  /** When true (default), write context.rootFile to the compile root. */
  setRootFile?: boolean;
  /** Confirm overwrite when conflicts exist. Caller may pre-confirm. */
  overwriteConfirmed?: boolean;
  extensionContext: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  /** Refresh Project TreeView after write. */
  refreshProjectView?: () => void;
}

export type ApplyPlanResult =
  | { ok: true; rootFile: string; written: string[] }
  | { ok: false; reason: 'cancelled' | 'conflicts' | 'no-workspace' | 'write-failed'; message: string };

function workspaceRelative(absPath: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    const root = f.uri.fsPath;
    if (absPath === root || absPath.startsWith(root + path.sep)) {
      return path.relative(root, absPath);
    }
  }
  return absPath;
}

/**
 * Detect conflicts against the live filesystem (plan.conflicts may be stale).
 */
export function liveConflicts(plan: StructurePlan): string[] {
  return plan.files.map((f) => f.path).filter((p) => fs.existsSync(p));
}

/**
 * Apply the plan. Prefer a single WorkspaceEdit so create is all-or-nothing
 * from the editor’s point of view.
 */
export async function applyStructurePlan(
  opts: ApplyPlanOptions,
): Promise<ApplyPlanResult> {
  const { plan, extensionContext, output } = opts;
  const setRootFile = opts.setRootFile !== false;

  if (!vscode.workspace.workspaceFolders?.length) {
    return {
      ok: false,
      reason: 'no-workspace',
      message: 'Open a folder before creating a ConTeXt document structure.',
    };
  }

  const conflicts = liveConflicts(plan);
  if (conflicts.length > 0 && !opts.overwriteConfirmed) {
    const sample = conflicts
      .slice(0, 8)
      .map((p) => workspaceRelative(p))
      .join('\n');
    const more =
      conflicts.length > 8 ? `\n… and ${conflicts.length - 8} more` : '';
    const choice = await vscode.window.showWarningMessage(
      `These files already exist and would be overwritten:\n${sample}${more}`,
      { modal: true },
      'Overwrite',
    );
    if (choice !== 'Overwrite') {
      return {
        ok: false,
        reason: 'cancelled',
        message: 'Create cancelled (existing files not overwritten).',
      };
    }
  }

  // Refuse if any generated file still somehow contains magic root
  for (const f of plan.files) {
    if (/%\s*!TEX\s+root/i.test(f.contents)) {
      return {
        ok: false,
        reason: 'write-failed',
        message: `Refusing to write ${f.relativePath}: contains % !TEX root`,
      };
    }
  }

  const edit = new vscode.WorkspaceEdit();
  for (const f of plan.files) {
    const uri = vscode.Uri.file(f.path);
    const overwrite = conflicts.includes(f.path);
    edit.createFile(uri, { overwrite, ignoreIfExists: false });
    edit.insert(uri, new vscode.Position(0, 0), f.contents);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    return {
      ok: false,
      reason: 'write-failed',
      message: 'WorkspaceEdit failed; no files were written.',
    };
  }

  const written = plan.files.map((f) => f.path);
  output.appendLine(
    `[projectManager] created tier=${plan.tier} files=${written.length} root=${plan.rootFile}`,
  );
  for (const f of plan.files) {
    output.appendLine(`  ${f.role.padEnd(12)} ${workspaceRelative(f.path)}`);
  }

  if (setRootFile && plan.rootFile) {
    const rel = workspaceRelative(plan.rootFile);
    const cfg = vscode.workspace.getConfiguration('context');
    await cfg.update('rootFile', rel, vscode.ConfigurationTarget.Workspace);
    output.appendLine(`[projectManager] set context.rootFile=${rel}`);
  }

  try {
    const doc = await vscode.workspace.openTextDocument(plan.rootFile);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    output.appendLine(
      `[projectManager] open root failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  opts.refreshProjectView?.();
  // Also poke the command so any other listeners refresh
  void vscode.commands.executeCommand('context.projectView.refresh');

  const openDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === plan.rootFile,
  );
  await maybeOfferTexContextAssociation(
    extensionContext,
    plan.rootFile,
    openDoc?.languageId,
    (line) => output.appendLine(line),
  );

  return { ok: true, rootFile: plan.rootFile, written };
}
