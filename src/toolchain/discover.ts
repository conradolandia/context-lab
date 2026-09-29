import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import {
  findBinaryUnderRoot,
  inferRootFromBinary,
  resolveInstallRoot,
} from './paths';

export {
  candidateBinDirs,
  findBinaryUnderRoot,
  inferRootFromBinary,
  isInstallRoot,
  resolveInstallRoot,
  walkToInstallRoot,
} from './paths';

export interface Toolchain {
  contextPath: string;
  mtxrunPath: string;
  /** Effective ConTeXt installation root (parent of tex/), from setting or inferred. */
  root?: string;
}

export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolchainError';
  }
}

function readSetting(key: string): string {
  const cfg = vscode.workspace.getConfiguration('context');
  const value = cfg.get<string>(key, '');
  return typeof value === 'string' ? value.trim() : '';
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function which(binary: string): string | undefined {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [binary], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first && isExecutable(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

export function resolveToolchain(
  overrides?: Partial<{
    root: string;
    contextPath: string;
    mtxrunPath: string;
  }>,
): Toolchain {
  const contextPathSetting = overrides?.contextPath ?? readSetting('contextPath');
  const mtxrunPathSetting = overrides?.mtxrunPath ?? readSetting('mtxrunPath');
  const rootSetting = overrides?.root ?? readSetting('root');

  let contextPath: string | undefined;
  let mtxrunPath: string | undefined;
  let root: string | undefined;

  if (contextPathSetting) {
    if (!isExecutable(contextPathSetting)) {
      throw new ToolchainError(
        `context.contextPath is set but not executable: ${contextPathSetting}`,
      );
    }
    contextPath = contextPathSetting;
  }

  if (mtxrunPathSetting) {
    if (!isExecutable(mtxrunPathSetting)) {
      throw new ToolchainError(
        `context.mtxrunPath is set but not executable: ${mtxrunPathSetting}`,
      );
    }
    mtxrunPath = mtxrunPathSetting;
  }

  if (rootSetting) {
    // Normalize: context.root is the install root (parent of tex/)
    root = resolveInstallRoot(rootSetting) ?? rootSetting;
    if (!contextPath) {
      contextPath = findBinaryUnderRoot(root, 'context');
    }
    if (!mtxrunPath) {
      mtxrunPath = findBinaryUnderRoot(root, 'mtxrun');
    }
  }

  if (!contextPath) {
    contextPath = which('context');
  }
  if (!mtxrunPath) {
    mtxrunPath = which('mtxrun');
  }

  if (!root) {
    root =
      inferRootFromBinary(contextPath ?? '') ??
      inferRootFromBinary(mtxrunPath ?? '') ??
      undefined;
  } else {
    // Re-normalize in case setting pointed at bin/texmf-linux-64
    root = resolveInstallRoot(root) ?? root;
  }

  if (!contextPath || !mtxrunPath) {
    const missing = [
      !contextPath ? '`context`' : undefined,
      !mtxrunPath ? '`mtxrun`' : undefined,
    ]
      .filter(Boolean)
      .join(' and ');
    throw new ToolchainError(
      `Could not find ${missing}. Set context.root to your ConTeXt installation root ` +
        `(the directory that contains tex/, for example: $HOME/context), ` +
        `set context.contextPath / context.mtxrunPath, or ensure both binaries are on PATH.`,
    );
  }

  return { contextPath, mtxrunPath, root };
}
