import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Toolchain } from '../toolchain/discover';

export interface BuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sourcePath: string;
  pdfPath: string;
  cwd: string;
}

export interface BuildOptions {
  extraArgs?: string[];
  cwd?: string;
  output?: vscode.OutputChannel;
}

function jobPdfPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}.pdf`);
}

/**
 * Run `context --synctex=repeat` (+ extra args) on the given source file.
 * Does not touch the viewer; caller runs the artifact gate on success.
 */
export function runContextBuild(
  toolchain: Toolchain,
  sourcePath: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const cwd = options.cwd ?? path.dirname(sourcePath);
  const cfg = vscode.workspace.getConfiguration('context');
  const settingArgs = cfg.get<string[]>('build.args', []) ?? [];
  const extraArgs = options.extraArgs ?? settingArgs;

  const args = ['--synctex=repeat', ...extraArgs, sourcePath];
  const output = options.output;

  output?.appendLine(`$ ${toolchain.contextPath} ${args.join(' ')}`);
  output?.appendLine(`cwd: ${cwd}`);

  return new Promise((resolve, reject) => {
    const child = spawn(toolchain.contextPath, args, {
      cwd,
      env: process.env,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      output?.append(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      output?.append(text);
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      output?.appendLine(`\n[exit ${exitCode}]`);
      resolve({
        exitCode,
        stdout,
        stderr,
        sourcePath,
        pdfPath: jobPdfPath(sourcePath),
        cwd,
      });
    });
  });
}
