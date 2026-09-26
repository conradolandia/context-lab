import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

export interface ContextBuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sourcePath: string;
  pdfPath: string;
  cwd: string;
}

export interface SpawnContextBuildOptions {
  contextPath: string;
  sourcePath: string;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface SpawnContextBuildHandle {
  child: ChildProcess;
  promise: Promise<ContextBuildResult>;
}

function jobPdfPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}.pdf`);
}

/**
 * Spawn ConTeXt with stdin ignored.
 *
 * Node's default stdio leaves stdin as an open pipe. Some ConTeXt/LuaMetaTeX
 * runs wait on that pipe and never produce output — the build promise never
 * settles and the extension's `building` flag stays true (cannot restart).
 */
export function spawnContextBuild(options: SpawnContextBuildOptions): SpawnContextBuildHandle {
  const { contextPath, sourcePath, cwd, args, env, onStdout, onStderr } = options;

  const child = spawn(contextPath, args, {
    cwd,
    env: env ?? process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const promise = new Promise<ContextBuildResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        sourcePath,
        pdfPath: jobPdfPath(sourcePath),
        cwd,
      });
    });
  });

  return { child, promise };
}
