import type * as vscode from 'vscode';
import type { JobSnapshot } from '../build/artifactGate';
import type { BuildController } from '../build/buildController';
import type { DigestifClientHandle } from '../lsp/digestifClient';
import type { RootResolution } from '../project/rootFile';
import type { PdfPanel } from '../viewer/pdfPanel';

export const LAST_GATED_PDF_STATE_KEY = 'context.lastGatedPdf';

/**
 * Mutable runtime shared by activate wiring and command modules.
 * Fields that activate always initializes before commands run use definite assignment.
 */
export const runtime = {
  output: undefined! as vscode.OutputChannel,
  digestifOutput: undefined! as vscode.OutputChannel,
  pdfPanel: undefined! as PdfPanel,
  rootStatus: undefined! as vscode.StatusBarItem,
  buildStatus: undefined! as vscode.StatusBarItem,
  modesStatus: undefined! as vscode.StatusBarItem,
  buildDiagnostics: undefined! as vscode.DiagnosticCollection,
  foldDiagnostics: undefined! as vscode.DiagnosticCollection,
  snapshot: undefined as JobSnapshot | undefined,
  generation: 0,
  lastRootResolution: undefined as RootResolution | undefined,
  backwardInFlight: false,
  digestif: undefined as DigestifClientHandle | undefined,
  extensionContext: undefined as vscode.ExtensionContext | undefined,
  buildController: undefined as BuildController | undefined,
};
