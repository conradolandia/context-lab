import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';

export interface Toolchain {
  contextPath: string;
  mtxrunPath: string;
  /** Effective ConTeXt root when known (from setting or inferred from PATH). */
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

/** Candidate bin dirs under an LMTX / ConTeXt root. */
export function candidateBinDirs(root: string): string[] {
  const platformHints = [
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'osx-arm64'
        : 'osx-64'
      : process.platform === 'win32'
        ? 'mswin'
        : process.arch === 'arm64'
          ? 'linux-aarch64'
          : 'linux-64',
    'linux-64',
    'linux-aarch64',
    'osx-64',
    'osx-arm64',
    'mswin',
  ];

  const dirs: string[] = [];
  const push = (p: string) => {
    if (!dirs.includes(p)) {
      dirs.push(p);
    }
  };

  push(path.join(root, 'bin'));
  for (const hint of platformHints) {
    push(path.join(root, 'bin', hint));
    push(path.join(root, 'tex', `texmf-${hint}`, 'bin'));
  }
  // Flat installs sometimes put binaries directly under root
  push(root);
  return dirs;
}

export function findBinaryUnderRoot(root: string, name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of candidateBinDirs(root)) {
    const candidate = path.join(dir, exe);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Infer LMTX-like root from a binary realpath (e.g. tex/texmf-OS/bin/context). */
export function inferRootFromBinary(binaryPath: string): string | undefined {
  try {
    const resolved = fs.realpathSync(binaryPath);
    const parts = resolved.split(path.sep);
    const binIdx = parts.lastIndexOf('bin');
    if (binIdx > 0) {
      const parent = parts[binIdx - 1];
      if (parent.startsWith('texmf-')) {
        // …/tex/texmf-linux-64/bin/context → root is two levels above texmf-*
        const texIdx = binIdx - 2;
        if (texIdx >= 0 && parts[texIdx] === 'tex') {
          return parts.slice(0, texIdx).join(path.sep) || path.sep;
        }
        return parts.slice(0, binIdx - 1).join(path.sep) || path.sep;
      }
      // …/bin/<platform>/context or …/bin/context
      if (binIdx >= 1) {
        return parts.slice(0, binIdx).join(path.sep) || path.sep;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
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
    root = rootSetting;
    if (!contextPath) {
      contextPath = findBinaryUnderRoot(rootSetting, 'context');
    }
    if (!mtxrunPath) {
      mtxrunPath = findBinaryUnderRoot(rootSetting, 'mtxrun');
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
  }

  if (!contextPath || !mtxrunPath) {
    const missing = [
      !contextPath ? '`context`' : undefined,
      !mtxrunPath ? '`mtxrun`' : undefined,
    ]
      .filter(Boolean)
      .join(' and ');
    throw new ToolchainError(
      `Could not find ${missing}. Set context.root to your LMTX install ` +
        `(example: /home/andi/Apps/lmtx), set context.contextPath / context.mtxrunPath, ` +
        `or ensure both binaries are on PATH.`,
    );
  }

  return { contextPath, mtxrunPath, root };
}
