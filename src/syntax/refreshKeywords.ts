import * as vscode from 'vscode';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveToolchain, ToolchainError } from '../toolchain/discover';

/**
 * Run scripts/generate-context-keywords.mjs against the user's LMTX tree
 * (same root discovery as build/SyncTeX), then offer a window reload.
 */
export async function refreshCommandKeywords(
  extensionPath: string,
  output: vscode.OutputChannel,
): Promise<void> {
  let root: string | undefined;
  try {
    root = resolveToolchain().root;
  } catch (err) {
    if (err instanceof ToolchainError) {
      void vscode.window.showErrorMessage(
        `ConTeXt: cannot refresh keywords — ${err.message}`,
      );
      return;
    }
    throw err;
  }

  if (!root) {
    void vscode.window.showErrorMessage(
      'ConTeXt: cannot refresh keywords — set context.root to your ConTeXt installation root (the directory that contains tex/, not bin/).',
    );
    return;
  }

  const script = path.join(extensionPath, 'scripts', 'generate-context-keywords.mjs');
  output.appendLine(`[keywords] refresh via ${script}`);
  output.appendLine(`[keywords] CONTEXT_ROOT=${root}`);

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolvePromise) => {
      const child = spawn(process.execPath, [script, '--root', root!], {
        cwd: extensionPath,
        env: { ...process.env, CONTEXT_ROOT: root },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        resolvePromise({ code: 1, stdout, stderr: String(err) });
      });
      child.on('close', (code) => {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    },
  );

  if (result.stdout.trim()) {
    output.appendLine(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    output.appendLine(result.stderr.trimEnd());
  }

  if (result.code !== 0) {
    void vscode.window.showErrorMessage(
      `ConTeXt: keyword refresh failed (exit ${result.code}). See the ConTeXt output channel.`,
    );
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    'ConTeXt command keywords updated. Reload the window to apply the TextMate grammar.',
    'Reload Window',
  );
  if (pick === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
