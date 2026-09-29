import * as fs from 'node:fs';
import * as path from 'node:path';

/** Relative path to the core ConTeXt interface XML under a typical LMTX tree. */
export const CONTEXT_INTERFACE_REL = path.join(
  'tex',
  'texmf-context',
  'tex',
  'context',
  'interface',
  'mkiv',
  'context-en.xml',
);

/** Relative path to the texmf-context tree under the install root. */
export const TEXMF_CONTEXT_REL = path.join('tex', 'texmf-context');

/**
 * Relative path to SciTE lexer data tables under the install root
 * (`scite-context-data-{context,interfaces,tex}.lua`).
 */
export const SCITE_DATA_REL = path.join(
  'tex',
  'texmf-context',
  'context',
  'data',
  'scite',
  'context',
  'lexers',
  'data',
);

/**
 * True if `dir` looks like an LMTX / ConTeXt Standalone install root
 * (the directory that contains `tex/`, never a `bin/` folder).
 */
export function isInstallRoot(dir: string): boolean {
  if (!dir) {
    return false;
  }
  const base = path.basename(dir);
  if (base === 'bin') {
    return false;
  }
  const xml = path.join(dir, CONTEXT_INTERFACE_REL);
  if (fs.existsSync(xml) && fs.statSync(xml).isFile()) {
    return true;
  }
  const texmfContext = path.join(dir, TEXMF_CONTEXT_REL);
  return fs.existsSync(texmfContext) && fs.statSync(texmfContext).isDirectory();
}

/**
 * Walk from `start` (file or directory) up toward filesystem root until an
 * install root is found (contains `tex/texmf-context/…/context-en.xml` or
 * at least `tex/texmf-context`). Returns undefined if none found.
 */
export function walkToInstallRoot(start: string): string | undefined {
  if (!start) {
    return undefined;
  }
  let dir: string;
  try {
    const resolved = fs.realpathSync(start);
    dir = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      ? path.dirname(resolved)
      : resolved;
  } catch {
    dir = fs.existsSync(start) && fs.statSync(start).isFile()
      ? path.dirname(start)
      : start;
  }

  for (let i = 0; i < 12; i++) {
    if (isInstallRoot(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Normalize a candidate path to the ConTeXt installation root (parent of tex/).
 * - If already an install root, return it.
 * - Otherwise walk parents (handles bin dirs, texmf-linux-64, mistaken settings).
 */
export function resolveInstallRoot(candidate: string): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isInstallRoot(trimmed)) {
    return path.resolve(trimmed);
  }
  return walkToInstallRoot(trimmed);
}

/** Candidate bin dirs under a ConTeXt installation root. Pure (no vscode). */
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

  // Standalone / LMTX: {root}/tex/texmf-<platform>/bin
  for (const hint of platformHints) {
    push(path.join(root, 'tex', `texmf-${hint}`, 'bin'));
  }
  // Older / alternate layouts
  push(path.join(root, 'bin'));
  for (const hint of platformHints) {
    push(path.join(root, 'bin', hint));
  }
  // Flat installs sometimes put binaries directly under root
  push(root);
  return dirs;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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

/**
 * Infer ConTeXt installation root from a binary realpath.
 * Walks parents until `tex/texmf-context/…/context-en.xml` (or texmf-context) exists.
 * Never returns a `bin/` directory.
 */
export function inferRootFromBinary(binaryPath: string): string | undefined {
  if (!binaryPath) {
    return undefined;
  }
  return walkToInstallRoot(binaryPath);
}
