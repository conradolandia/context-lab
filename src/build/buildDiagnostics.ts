import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseContextLog, type ParsedDiagnostic } from './parseLog';

export const BUILD_DIAG_COLLECTION = 'context.build';

function severityToVsCode(s: ParsedDiagnostic['severity']): vscode.DiagnosticSeverity {
  switch (s) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
  }
}

function resolveDiagFile(
  file: string | undefined,
  cwd: string,
  fallbackRoot: string,
): string {
  if (!file) {
    return fallbackRoot;
  }
  if (path.isAbsolute(file)) {
    return file;
  }
  return path.resolve(cwd, file);
}

/**
 * Publish build diagnostics into a VS Code DiagnosticCollection.
 * Clears previous `context.build` entries first.
 */
export function publishBuildDiagnostics(
  collection: vscode.DiagnosticCollection,
  opts: {
    cwd: string;
    rootFile: string;
    stdout: string;
    stderr: string;
    logText?: string;
  },
): ParsedDiagnostic[] {
  collection.clear();
  const blob = [opts.stdout, opts.stderr, opts.logText ?? ''].join('\n');
  const parsed = parseContextLog(blob, { cwd: opts.cwd });

  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const d of parsed) {
    const abs = resolveDiagFile(d.file, opts.cwd, opts.rootFile);
    const uri = vscode.Uri.file(abs);
    const line = Math.max(0, (d.line ?? 1) - 1);
    const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
    const diag = new vscode.Diagnostic(range, d.message, severityToVsCode(d.severity));
    diag.source = d.source;
    const key = uri.toString();
    const list = byUri.get(key) ?? [];
    list.push(diag);
    byUri.set(key, list);
  }

  for (const [key, diags] of byUri) {
    collection.set(vscode.Uri.parse(key), diags);
  }
  return parsed;
}

export function clearBuildDiagnostics(collection: vscode.DiagnosticCollection): void {
  collection.clear();
}
