import * as fs from 'node:fs';
import * as path from 'node:path';

/** Candidate bin dirs under an LMTX / ConTeXt root. Pure (no vscode). */
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
