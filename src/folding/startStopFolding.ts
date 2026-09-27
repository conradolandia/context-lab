import * as vscode from 'vscode';
import { analyzeStartStop, type FoldAnalysis } from './startStopAnalyze';

export { analyzeStartStop, type FoldAnalysis } from './startStopAnalyze';

export const FOLD_DIAG_COLLECTION = 'context.folding';

function isContextDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'context' || doc.languageId === 'tex';
}

export function publishFoldDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  analysis?: FoldAnalysis,
): FoldAnalysis {
  const result = analysis ?? analyzeStartStop(document.getText());
  const diags: vscode.Diagnostic[] = [];
  for (const m of result.mismatches) {
    if (m.startName === '(none)') {
      const range = new vscode.Range(
        document.positionAt(m.stopOffset),
        document.positionAt(m.stopEndOffset),
      );
      diags.push(
        new vscode.Diagnostic(
          range,
          `\\stop${m.stopName} has no matching \\start${m.stopName}`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
      continue;
    }
    const stopRange = new vscode.Range(
      document.positionAt(m.stopOffset),
      document.positionAt(m.stopEndOffset),
    );
    const d = new vscode.Diagnostic(
      stopRange,
      `\\start${m.startName} closed by \\stop${m.stopName}`,
      vscode.DiagnosticSeverity.Warning,
    );
    d.relatedInformation = [
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(
          document.uri,
          new vscode.Range(
            document.positionAt(m.startOffset),
            document.positionAt(m.startEndOffset),
          ),
        ),
        `\\start${m.startName}`,
      ),
    ];
    diags.push(d);
  }
  for (const u of result.unclosed) {
    const range = new vscode.Range(
      document.positionAt(u.offset),
      document.positionAt(u.endOffset),
    );
    diags.push(
      new vscode.Diagnostic(
        range,
        `\\start${u.name} is not closed`,
        vscode.DiagnosticSeverity.Warning,
      ),
    );
  }
  for (const d of diags) {
    d.source = FOLD_DIAG_COLLECTION;
  }
  collection.set(document.uri, diags);
  return result;
}

export class ContextFoldingRangeProvider implements vscode.FoldingRangeProvider {
  constructor(private readonly diagnostics: vscode.DiagnosticCollection) {}

  provideFoldingRanges(
    document: vscode.TextDocument,
    _context: vscode.FoldingContext,
    _token: vscode.CancellationToken,
  ): vscode.FoldingRange[] {
    if (!isContextDoc(document)) {
      return [];
    }
    const analysis = analyzeStartStop(document.getText());
    publishFoldDiagnostics(document, this.diagnostics, analysis);
    return analysis.ranges.map(
      (r) => new vscode.FoldingRange(r.startLine, r.endLine, vscode.FoldingRangeKind.Region),
    );
  }
}
