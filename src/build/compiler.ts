import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Toolchain } from '../toolchain/discover';
import { spawnContextBuild, type ContextBuildResult } from './spawnContext';

export type { ContextBuildResult as BuildResult } from './spawnContext';
export { spawnContextBuild } from './spawnContext';

export interface BuildOptions {
  extraArgs?: string[];
  cwd?: string;
  output?: vscode.OutputChannel;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `context --synctex=repeat` (+ extra args) on the given source file.
 * Does not touch DigestiF or the viewer; caller runs the artifact gate on success.
 */
export function runContextBuild(
  toolchain: Toolchain,
  sourcePath: string,
  options: BuildOptions = {},
): Promise<ContextBuildResult> {
  const cwd = options.cwd ?? path.dirname(sourcePath);
  const cfg = vscode.workspace.getConfiguration('context');
  const settingArgs = cfg.get<string[]>('build.args', []) ?? [];
  const extraArgs = options.extraArgs ?? settingArgs;

  const args = ['--synctex=repeat', ...extraArgs, sourcePath];
  const output = options.output;

  output?.appendLine(`$ ${toolchain.contextPath} ${args.join(' ')}`);
  output?.appendLine(`cwd: ${cwd}`);

  const { promise } = spawnContextBuild({
    contextPath: toolchain.contextPath,
    sourcePath,
    cwd,
    args,
    env: options.env ?? process.env,
    onStdout: (text) => output?.append(text),
    onStderr: (text) => output?.append(text),
  });

  return promise.then((result) => {
    output?.appendLine(`\n[exit ${result.exitCode}]`);
    return result;
  });
}
