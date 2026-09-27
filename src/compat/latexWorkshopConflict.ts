import * as vscode from 'vscode';
import {
  DONT_ASK_SETTING,
  DONT_ASK_STATE_KEY,
  LATEX_WORKSHOP_EXT_ID,
  latexWorkshopContributesContextLanguage,
  shouldWarnLatexWorkshopConflict,
  upsertExtensionsJsonUnwanted,
} from './latexWorkshopConflictPolicy';

const DISABLE_ACTION = 'Disable LaTeX Workshop for this workspace';
const ADD_RECOMMENDATION_ACTION = 'Add workspace recommendation';
const DONT_SHOW_AGAIN_ACTION = "Don't show again";

/** Session gate so we do not re-prompt on every context document open. */
let shownThisSession = false;

export function resetLatexWorkshopConflictSessionFlagForTests(): void {
  shownThisSession = false;
}

function resolveDontAsk(extensionContext: vscode.ExtensionContext): boolean {
  return (
    extensionContext.globalState.get<boolean>(DONT_ASK_STATE_KEY) === true ||
    extensionContext.workspaceState.get<boolean>(DONT_ASK_STATE_KEY) === true ||
    vscode.workspace.getConfiguration('context').get<boolean>(DONT_ASK_SETTING, false)
  );
}

function inspectLatexWorkshop(): {
  present: boolean;
  contributesContext: boolean;
} {
  const ext = vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID);
  if (!ext) {
    return { present: false, contributesContext: false };
  }
  return {
    present: true,
    contributesContext: latexWorkshopContributesContextLanguage(ext.packageJSON),
  };
}

/**
 * Try to disable LaTeX Workshop for the current workspace via the workbench
 * command used by several hosts. Falls back to opening the Extensions view
 * focused on that extension so the user can choose Disable (Workspace).
 */
async function disableLatexWorkshopForWorkspace(
  log?: (line: string) => void,
): Promise<'disabled' | 'guided'> {
  try {
    await vscode.commands.executeCommand(
      'workbench.extensions.disableExtension',
      LATEX_WORKSHOP_EXT_ID,
    );
    log?.(`[compat] disabled ${LATEX_WORKSHOP_EXT_ID} via workbench.extensions.disableExtension`);
    return 'disabled';
  } catch (err) {
    log?.(
      `[compat] workbench.extensions.disableExtension failed (${String(err)}); opening Extensions view`,
    );
  }

  try {
    await vscode.commands.executeCommand(
      'workbench.extensions.search',
      `@id:${LATEX_WORKSHOP_EXT_ID}`,
    );
  } catch {
    try {
      await vscode.commands.executeCommand('extension.open', LATEX_WORKSHOP_EXT_ID);
    } catch {
      // last resort: message only
    }
  }
  return 'guided';
}

async function addWorkspaceUnwantedRecommendation(
  log?: (line: string) => void,
): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      'Open a folder workspace to write .vscode/extensions.json.',
    );
    return false;
  }

  const dirUri = vscode.Uri.joinPath(folder.uri, '.vscode');
  const fileUri = vscode.Uri.joinPath(dirUri, 'extensions.json');

  let existing: unknown;
  try {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    existing = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
  } catch {
    existing = undefined;
  }

  const next = upsertExtensionsJsonUnwanted(existing);
  const body = `${JSON.stringify(next, null, 2)}\n`;

  try {
    await vscode.workspace.fs.createDirectory(dirUri);
  } catch {
    // may already exist
  }
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(body, 'utf8'));
  log?.(
    `[compat] wrote unwantedRecommendations for ${LATEX_WORKSHOP_EXT_ID} → ${fileUri.fsPath}`,
  );
  return true;
}

/**
 * Detect enabled LaTeX Workshop that contributes language id `context` and
 * warn once (session + don't-show-again). Never auto-disables without a click.
 */
export async function maybeWarnLatexWorkshopConflict(
  extensionContext: vscode.ExtensionContext,
  log?: (line: string) => void,
): Promise<void> {
  const lw = inspectLatexWorkshop();
  const dontAsk = resolveDontAsk(extensionContext);
  const development =
    extensionContext.extensionMode === vscode.ExtensionMode.Development;

  if (
    !shouldWarnLatexWorkshopConflict({
      dontAsk,
      alreadyShownThisSession: shownThisSession,
      lwExtensionPresent: lw.present,
      lwContributesContext: lw.contributesContext,
      extensionModeDevelopment: development,
    })
  ) {
    if (development && lw.present && lw.contributesContext) {
      log?.(
        `[compat] LaTeX Workshop (${LATEX_WORKSHOP_EXT_ID}) also contributes language id context; ` +
          'skipped warning in Extension Development Host (F5 grammar registers last and wins)',
      );
    }
    return;
  }

  shownThisSession = true;
  log?.(
    `[compat] LaTeX Workshop (${LATEX_WORKSHOP_EXT_ID}) contributes language id context — warning once`,
  );

  const choice = await vscode.window.showWarningMessage(
    'LaTeX Workshop is enabled and also contributes language id "context", so its grammar ' +
      '(text.tex.latex) can override ConTeXt Tools (text.tex.context). Disable LaTeX Workshop ' +
      'for this workspace when editing ConTeXt.',
    DISABLE_ACTION,
    ADD_RECOMMENDATION_ACTION,
    DONT_SHOW_AGAIN_ACTION,
  );

  if (choice === DISABLE_ACTION) {
    const result = await disableLatexWorkshopForWorkspace(log);
    if (result === 'disabled') {
      void vscode.window.showInformationMessage(
        'LaTeX Workshop disabled for this workspace. Reload the window if highlighting does not update.',
      );
    } else {
      void vscode.window.showInformationMessage(
        'Could not disable via API. In the Extensions view, open LaTeX Workshop and choose Disable (Workspace).',
      );
    }
  } else if (choice === ADD_RECOMMENDATION_ACTION) {
    const ok = await addWorkspaceUnwantedRecommendation(log);
    if (ok) {
      void vscode.window.showInformationMessage(
        'Added James-Yu.latex-workshop to .vscode/extensions.json unwantedRecommendations. ' +
          'That suppresses the Marketplace recommendation; still use Disable (Workspace) if it is installed.',
      );
    }
  } else if (choice === DONT_SHOW_AGAIN_ACTION) {
    await extensionContext.globalState.update(DONT_ASK_STATE_KEY, true);
    log?.('[compat] will not warn again about LaTeX Workshop language-id conflict');
  }
}
