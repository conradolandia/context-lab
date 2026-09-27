import * as vscode from 'vscode';
import { shouldOfferTexContextAssociation } from './texAssociationPolicy';

const DONT_ASK_STATE = 'context.texAssociation.dontAsk';
const DONT_ASK_SETTING = 'context.texAssociation.dontAsk';

/**
 * Once per workspace: when building/previewing a .tex file that is not in
 * ConTeXt language mode, offer to set files.associations["*.tex"] = "context"
 * so DigestiF loads ConTeXt (not LaTeX). DigestiF maps languageId "tex" → latex
 * and "context" → context.
 */
export async function maybeOfferTexContextAssociation(
  extensionContext: vscode.ExtensionContext,
  filePath: string,
  languageId: string | undefined,
  log?: (line: string) => void,
): Promise<void> {
  const associations =
    vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {};
  const dontAsk =
    extensionContext.workspaceState.get<boolean>(DONT_ASK_STATE) === true ||
    vscode.workspace.getConfiguration('context').get<boolean>(DONT_ASK_SETTING, false);

  if (
    !shouldOfferTexContextAssociation({
      filePath,
      languageId,
      dontAsk,
      existingAssociation: associations['*.tex'],
    })
  ) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'This .tex file is not in ConTeXt language mode. DigestiF treats "tex" as LaTeX. ' +
      'Associate *.tex with ConTeXt for this workspace?',
    'Associate *.tex → ConTeXt',
    "Don't ask again",
  );

  if (choice === 'Associate *.tex → ConTeXt') {
    const filesCfg = vscode.workspace.getConfiguration('files');
    const next = {
      ...(filesCfg.get<Record<string, string>>('associations') ?? {}),
      '*.tex': 'context',
    };
    await filesCfg.update('associations', next, vscode.ConfigurationTarget.Workspace);
    log?.('[tex] set files.associations["*.tex"]="context" (workspace)');
    void vscode.window.showInformationMessage(
      'Associated *.tex with ConTeXt. Re-open the file or click the language mode in the status bar if DigestiF does not attach yet.',
    );
  } else if (choice === "Don't ask again") {
    await extensionContext.workspaceState.update(DONT_ASK_STATE, true);
    log?.('[tex] will not ask again about *.tex → ConTeXt association');
  }
}

export { shouldOfferTexContextAssociation } from './texAssociationPolicy';
