import * as vscode from 'vscode';
import {
  appendModeToCatalog,
  formatModesStatusText,
  normalizeModes,
} from '../build/buildModes';
import { logUser } from '../outputLog';
import { runtime } from './state';

const MODES_SETTING = 'build.modes';
const ACTIVE_MODES_SETTING = 'build.activeModes';
const ADD_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('add'),
  tooltip: 'Add mode…',
};

function readModesCatalog(): string[] {
  const cfg = vscode.workspace.getConfiguration('context');
  return normalizeModes(cfg.get<string[]>(MODES_SETTING, []) ?? []);
}

function readActiveModes(): string[] {
  const cfg = vscode.workspace.getConfiguration('context');
  return normalizeModes(cfg.get<string[]>(ACTIVE_MODES_SETTING, []) ?? []);
}

export function updateModesStatus(): void {
  const active = readActiveModes();
  runtime.modesStatus.text = formatModesStatusText(active);
  runtime.modesStatus.tooltip =
    active.length === 0
      ? 'No ConTeXt build modes active — click to select'
      : `Active ConTeXt modes: ${active.join(', ')}\nClick to change (context.build.activeModes)`;
}

async function persistActiveModes(modes: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('context');
  await cfg.update(ACTIVE_MODES_SETTING, normalizeModes(modes), vscode.ConfigurationTarget.Workspace);
  updateModesStatus();
  const active = normalizeModes(modes);
  logUser(
    active.length === 0
      ? '[modes] cleared context.build.activeModes'
      : `[modes] active=${active.join(',')}`,
  );
}

async function persistCatalog(modes: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('context');
  await cfg.update(MODES_SETTING, normalizeModes(modes), vscode.ConfigurationTarget.Workspace);
}

async function promptAddMode(enableAlso: boolean): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Add ConTeXt build mode',
    prompt: 'Mode name (passed to context --mode=…)',
    placeHolder: 'draft',
    validateInput: (v) => {
      const t = v.trim();
      if (!t) {
        return 'Mode name cannot be empty';
      }
      if (/\s/.test(t)) {
        return 'Mode names cannot contain spaces';
      }
      return undefined;
    },
  });
  if (name == null) {
    return;
  }
  const trimmed = name.trim();
  const catalog = appendModeToCatalog(readModesCatalog(), trimmed);
  await persistCatalog(catalog);
  logUser(`[modes] catalog += ${trimmed}`);
  if (enableAlso) {
    const active = normalizeModes([...readActiveModes(), trimmed]);
    await persistActiveModes(active);
  }
}

/**
 * Multi-select QuickPick over `context.build.modes`.
 * Toolbar Add appends to the catalog; accepting selection writes activeModes.
 */
export async function selectBuildModes(): Promise<void> {
  const catalog = readModesCatalog();
  const active = new Set(readActiveModes());

  if (catalog.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No modes in context.build.modes. Add a mode name to the catalog?',
      'Add mode…',
    );
    if (choice === 'Add mode…') {
      await promptAddMode(true);
      if (readModesCatalog().length > 0) {
        await selectBuildModes();
      }
    }
    return;
  }

  const items: vscode.QuickPickItem[] = catalog.map((name) => ({
    label: name,
    picked: active.has(name),
  }));

  const qp = vscode.window.createQuickPick();
  qp.title = 'ConTeXt build modes';
  qp.placeholder = 'Select modes for --mode=… (empty = no --mode flag)';
  qp.canSelectMany = true;
  qp.items = items;
  qp.selectedItems = items.filter((i) => i.picked);
  qp.buttons = [ADD_BUTTON];
  qp.ignoreFocusOut = true;

  const result = await new Promise<vscode.QuickPickItem[] | 'add' | undefined>((resolve) => {
    let settled = false;
    const finish = (value: vscode.QuickPickItem[] | 'add' | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      qp.dispose();
      resolve(value);
    };
    qp.onDidTriggerButton((btn) => {
      if (btn === ADD_BUTTON) {
        finish('add');
      }
    });
    qp.onDidAccept(() => {
      finish([...qp.selectedItems]);
    });
    qp.onDidHide(() => {
      finish(undefined);
    });
    qp.show();
  });

  if (result === 'add') {
    await promptAddMode(true);
    await selectBuildModes();
    return;
  }
  if (result === undefined) {
    return;
  }
  const selected = normalizeModes(result.map((i) => i.label));
  // Keep catalog order for active modes when possible.
  const ordered = catalog.filter((m) => selected.includes(m));
  for (const m of selected) {
    if (!ordered.includes(m)) {
      ordered.push(m);
    }
  }
  await persistActiveModes(ordered);
}

/** Register status bar + command. Call from activate. */
export function registerBuildModesUi(subscriptions: { push(...items: { dispose(): void }[]): number }): void {
  runtime.modesStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  runtime.modesStatus.command = 'context.selectBuildModes';
  updateModesStatus();
  runtime.modesStatus.show();

  subscriptions.push(
    runtime.modesStatus,
    vscode.commands.registerCommand('context.selectBuildModes', () => {
      void selectBuildModes();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('context.build.activeModes') ||
        e.affectsConfiguration('context.build.modes')
      ) {
        updateModesStatus();
      }
    }),
  );
}
