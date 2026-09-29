/**
 * Command: ConTeXt: Upgrade Document Structure…
 * Spec-gated; refuses without `.context/structure.json`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyStructurePlan } from './applyPlan';
import { findStructureSpec, nextStructureTier } from './structureSpec';
import { TIER_INFO, type StructureTier } from './structureTiers';
import { buildUpgradePlan, upgradeRefusalMessage } from './structureUpgrade';

export interface UpgradeCommandDeps {
  extensionContext: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  refreshProjectView?: () => void;
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function startDirsForSpecSearch(): string[] {
  const dirs: string[] = [];
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active) {
    dirs.push(path.dirname(active));
  }
  const rootSetting =
    vscode.workspace.getConfiguration('context').get<string>('rootFile', '') ??
    '';
  if (rootSetting.trim()) {
    const folders = workspaceFolders();
    const abs = path.isAbsolute(rootSetting)
      ? rootSetting
      : folders[0]
        ? path.resolve(folders[0], rootSetting)
        : rootSetting;
    dirs.push(path.dirname(abs));
  }
  for (const f of workspaceFolders()) {
    dirs.push(f);
  }
  return dirs;
}

function locateSpec():
  | { scaffoldRoot: string; specPath: string; spec: import('./structureSpec').StructureSpec }
  | undefined {
  const stopAt = workspaceFolders();
  for (const start of startDirsForSpecSearch()) {
    const hit = findStructureSpec(start, { stopAt });
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

export async function runStructureUpgrade(
  deps: UpgradeCommandDeps,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showErrorMessage(
      'Open a folder before upgrading a ConTeXt document structure.',
    );
    return;
  }

  const located = locateSpec();
  if (!located) {
    const open = 'New Document Structure…';
    const choice = await vscode.window.showErrorMessage(
      upgradeRefusalMessage(),
      open,
    );
    if (choice === open) {
      await vscode.commands.executeCommand('context.projectManager.create');
    }
    return;
  }

  const { scaffoldRoot, spec } = located;
  const next = nextStructureTier(spec.tier);
  if (!next) {
    void vscode.window.showInformationMessage(
      `This structure is already at ${TIER_INFO.project.title}. Nothing to upgrade along wiki §1.`,
    );
    return;
  }

  const currentLabel = TIER_INFO[spec.tier].title;
  const nextLabel = TIER_INFO[next].title;
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: `Upgrade to ${nextLabel}`,
        description: `${TIER_INFO[next].wikiSection}`,
        detail: TIER_INFO[next].compileHint,
        tier: next as StructureTier,
      },
    ],
    {
      title: `Upgrade document structure (${currentLabel})`,
      placeHolder: `Current tier: ${currentLabel}. Compile root stays a product or document.`,
    },
  );
  if (!pick) {
    return;
  }

  let additionalProducts: string[] | undefined;
  if (spec.tier === 'product' && pick.tier === 'project') {
    const extra = await vscode.window.showInputBox({
      title: 'Additional products',
      prompt:
        'Comma-separated product names to add (project tier coordinates several products). Existing product is kept.',
      value: 'book-two',
    });
    if (extra === undefined) {
      return;
    }
    additionalProducts = extra
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  let plan;
  try {
    plan = buildUpgradePlan({
      scaffoldRoot,
      spec,
      toTier: pick.tier,
      additionalProducts,
    });
  } catch (err) {
    void vscode.window.showErrorMessage(
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const preview = [
    `Upgrade ${currentLabel} → ${nextLabel}`,
    `Scaffold: ${scaffoldRoot}`,
    `Compile root (product/document): ${plan.rootFile}`,
    '',
    ...plan.treeLines,
  ];
  if (plan.deletePaths?.length) {
    preview.push(
      '',
      'Will delete:',
      ...plan.deletePaths.map((p) => `  ${path.relative(scaffoldRoot, p)}`),
    );
  }
  if (plan.conflicts.length) {
    preview.push(
      '',
      'Conflicts:',
      ...plan.conflicts.map((p) => `  ${path.relative(scaffoldRoot, p)}`),
    );
  }

  const confirm = await vscode.window.showInformationMessage(
    preview.slice(0, 12).join('\n') +
      (preview.length > 12 ? '\n…' : ''),
    { modal: true },
    'Upgrade',
  );
  if (confirm !== 'Upgrade') {
    return;
  }

  const result = await applyStructurePlan({
    plan,
    extensionContext: deps.extensionContext,
    output: deps.output,
    refreshProjectView: deps.refreshProjectView,
    overwriteConfirmed: true,
    actionLabel: 'upgraded',
  });

  if (!result.ok) {
    void vscode.window.showErrorMessage(result.message);
    return;
  }

  void vscode.window.showInformationMessage(
    `Upgraded to ${nextLabel}. Compile root: ${path.basename(result.rootFile)}`,
  );
}
