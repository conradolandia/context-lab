import * as vscode from 'vscode';
import * as path from 'node:path';
import { resolveToolchain, type Toolchain } from '../toolchain/discover';
import { resolveRootFile, toWorkspaceRelativeRootFile, type RootResolution } from '../project/rootFile';
import { openTextFromDocuments, readTexSource } from '../project/readSource';
import type { ProjectNode } from '../project/projectModel';
import { logUser } from '../outputLog';
import { runtime } from './state';

export function getToolchain(): Toolchain {
  return resolveToolchain();
}

export function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

export function activeTexPath(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    return undefined;
  }
  return ed.document.uri.fsPath;
}

export function resolveCurrentRoot(activePath?: string): RootResolution | undefined {
  const active = activePath ?? activeTexPath() ?? runtime.lastRootResolution?.rootFile;
  if (!active) {
    return undefined;
  }
  const text = readTexSource(active, {
    getOpenText: openTextFromDocuments(vscode.workspace.textDocuments),
  });
  const cfg = vscode.workspace.getConfiguration('context');
  const setting = cfg.get<string>('rootFile', '') ?? '';
  const resolved = resolveRootFile({
    activeFile: active,
    activeText: text,
    rootFileSetting: setting,
    workspaceFolders: workspaceFolderPaths(),
  });
  runtime.lastRootResolution = resolved;
  return resolved;
}

export function updateRootStatus(): void {
  const r = resolveCurrentRoot();
  if (!r) {
    runtime.rootStatus.text = 'ConTeXt: (no root)';
    runtime.rootStatus.tooltip = 'Click to set context.rootFile';
    return;
  }
  const name = path.basename(r.rootFile);
  runtime.rootStatus.text = `ConTeXt: ${name}`;
  runtime.rootStatus.tooltip = `${r.rootFile}\nrule: ${r.rule}\nClick to change context.rootFile`;
}

export async function pickRootFile(): Promise<void> {
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
    const rel = toWorkspaceRelativeRootFile(uris[0].fsPath, folders);
    await cfg.update('rootFile', rel, vscode.ConfigurationTarget.Workspace);
    logUser(`[root] set context.rootFile=${rel}`);
  }
  updateRootStatus();
}

export function buildFromProjectNode(node: ProjectNode): void {
  if (node.kind === 'project') {
    const firstProduct = node.children.find((c) => c.kind === 'product' && c.fsPath && !c.missing);
    void vscode.window
      .showInformationMessage(
        'Project files are not compile targets (compiling a project can loop). Build a product instead.',
        firstProduct ? `Build ${firstProduct.label}` : 'OK',
      )
      .then((choice) => {
        if (firstProduct?.fsPath && choice?.startsWith('Build ')) {
          runtime.buildController?.requestCommandBuild(firstProduct.fsPath);
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
    runtime.buildController?.requestCommandBuild(node.fsPath);
    return;
  }

  // Component (and input): compile via resolveRootFile (product preferred).
  const text = readTexSource(node.fsPath, {
    getOpenText: openTextFromDocuments(vscode.workspace.textDocuments),
  });
  const cfg = vscode.workspace.getConfiguration('context');
  const resolved = resolveRootFile({
    activeFile: node.fsPath,
    activeText: text,
    rootFileSetting: cfg.get<string>('rootFile', '') ?? '',
    workspaceFolders: workspaceFolderPaths(),
  });
  runtime.buildController?.requestCommandBuild(resolved.rootFile);
}

export async function setRootFromProjectNode(node: ProjectNode): Promise<void> {
  if (!node.fsPath || node.missing) {
    void vscode.window.showErrorMessage('Cannot set root: file is missing or unresolved.');
    return;
  }
  const folders = workspaceFolderPaths();
  const rel = toWorkspaceRelativeRootFile(node.fsPath, folders);
  const cfg = vscode.workspace.getConfiguration('context');
  await cfg.update('rootFile', rel, vscode.ConfigurationTarget.Workspace);
  logUser(`[root] set context.rootFile=${rel} (from Project view)`);
  updateRootStatus();
}
