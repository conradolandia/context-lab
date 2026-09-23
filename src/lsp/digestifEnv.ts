import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { candidateBinDirs } from '../toolchain/paths';

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

export type DigestifEnvOk = {
  ok: true;
  digestifPath: string;
  interfaceXmlPath: string;
  /** Absolute texmf roots passed to DIGESTIF_TEXMF (colon/semicolon-separated). */
  texmfDirs: string[];
  /** Merged process env for the Digestif child. */
  env: NodeJS.ProcessEnv;
  root?: string;
};

export type DigestifEnvFail = {
  ok: false;
  kind: 'digestif-missing' | 'xml-missing';
  message: string;
};

export type DigestifEnvResult = DigestifEnvOk | DigestifEnvFail;

export interface BuildDigestifEnvOptions {
  /** Resolved LMTX / ConTeXt root (from context.root or inferred). */
  root?: string;
  /** Absolute override for the Digestif executable (context.digestifPath). */
  digestifPath?: string;
  /** Base env to merge into (defaults to process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Injected which() for tests. */
  whichDigestif?: () => string | undefined;
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

/**
 * Resolve the Digestif executable: optional absolute override, else PATH.
 */
export function resolveDigestifExecutable(
  digestifPathSetting?: string,
  whichDigestif: () => string | undefined = () => which('digestif'),
): string | undefined {
  const override = digestifPathSetting?.trim();
  if (override) {
    return isExecutable(override) ? override : undefined;
  }
  return whichDigestif();
}

/**
 * Locate context-en.xml under an LMTX-style root.
 * Prefers the canonical mkiv path; falls back to a shallow search under tex/.
 */
export function findContextInterfaceXml(root: string): string | undefined {
  if (!root) {
    return undefined;
  }
  const canonical = path.join(root, CONTEXT_INTERFACE_REL);
  if (fs.existsSync(canonical) && fs.statSync(canonical).isFile()) {
    return canonical;
  }

  // Alternate: texmf-context at root (no tex/ prefix)
  const alt = path.join(
    root,
    'texmf-context',
    'tex',
    'context',
    'interface',
    'mkiv',
    'context-en.xml',
  );
  if (fs.existsSync(alt) && fs.statSync(alt).isFile()) {
    return alt;
  }

  // Shallow walk: look for interface/mkiv/context-en.xml under tex/
  const texDir = path.join(root, 'tex');
  if (!fs.existsSync(texDir)) {
    return undefined;
  }
  return walkForInterfaceXml(texDir, 6);
}

function walkForInterfaceXml(dir: string, depth: number): string | undefined {
  if (depth < 0) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const hit = path.join(dir, 'context-en.xml');
  if (
    fs.existsSync(hit) &&
    path.basename(dir) === 'mkiv' &&
    path.basename(path.dirname(dir)) === 'interface'
  ) {
    return hit;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }
    const name = ent.name;
    if (name === '.' || name === '..' || name.startsWith('.')) {
      continue;
    }
    const found = walkForInterfaceXml(path.join(dir, name), depth - 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Collect texmf roots Digestif should scan (DIGESTIF_TEXMF).
 * Includes texmf-context and sibling tex/texmf-* trees when present.
 */
export function collectTexmfDirs(root: string, interfaceXmlPath?: string): string[] {
  const dirs: string[] = [];
  const push = (p: string) => {
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory() && !dirs.includes(p)) {
      dirs.push(p);
    }
  };

  const texDir = path.join(root, 'tex');
  if (fs.existsSync(texDir)) {
    push(path.join(texDir, 'texmf-context'));
    try {
      for (const name of fs.readdirSync(texDir)) {
        if (name.startsWith('texmf-')) {
          push(path.join(texDir, name));
        }
      }
    } catch {
      // ignore
    }
  }

  push(path.join(root, 'texmf-context'));

  // Ensure the texmf that contains the interface XML is included
  if (interfaceXmlPath) {
    const texmf = texmfRootFromInterfaceXml(interfaceXmlPath);
    if (texmf) {
      push(texmf);
    }
  }

  return dirs;
}

/**
 * Walk up from context-en.xml to the texmf-* directory that contains it.
 * e.g. …/tex/texmf-context/tex/context/interface/mkiv/context-en.xml → …/tex/texmf-context
 */
export function texmfRootFromInterfaceXml(xmlPath: string): string | undefined {
  let dir = path.dirname(xmlPath);
  for (let i = 0; i < 8; i++) {
    const base = path.basename(dir);
    if (base.startsWith('texmf-') || base === 'texmf') {
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

function pathListJoin(dirs: string[]): string {
  return dirs.join(process.platform === 'win32' ? ';' : ':');
}

/**
 * Build env + paths for starting Digestif against an LMTX tree.
 * Does not start the process; callers check `ok` and surface `message` on failure.
 */
export function buildDigestifEnv(options: BuildDigestifEnvOptions): DigestifEnvResult {
  const digestifPath = resolveDigestifExecutable(
    options.digestifPath,
    options.whichDigestif ?? (() => which('digestif')),
  );

  if (!digestifPath) {
    const hint = options.digestifPath?.trim()
      ? `context.digestifPath is set but not executable: ${options.digestifPath.trim()}`
      : 'Digestif executable not found on PATH. Install the Digestif wrapper script or `luarocks install digestif`, or set context.digestifPath.';
    return {
      ok: false,
      kind: 'digestif-missing',
      message: hint,
    };
  }

  const root = options.root?.trim() || undefined;
  if (!root) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        'ConTeXt interface XML not found: set context.root to your LMTX install ' +
        '(example: /home/andi/Apps/lmtx) so Digestif can load context-en.xml.',
    };
  }

  const interfaceXmlPath = findContextInterfaceXml(root);
  if (!interfaceXmlPath) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        `ConTeXt interface XML (context-en.xml) not found under ${root}. ` +
        `Expected something like ${path.join(root, CONTEXT_INTERFACE_REL)}. ` +
        `Check context.root points at the LMTX tree.`,
    };
  }

  const texmfDirs = collectTexmfDirs(root, interfaceXmlPath);
  if (texmfDirs.length === 0) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        `Found interface XML at ${interfaceXmlPath} but could not resolve a texmf root for DIGESTIF_TEXMF.`,
    };
  }

  const base = { ...(options.baseEnv ?? process.env) };
  const binDirs = candidateBinDirs(root).filter((d) => fs.existsSync(d));
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const existingPath = base.PATH ?? base.Path ?? '';
  const prepended = [...binDirs, existingPath].filter(Boolean).join(pathSep);

  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: prepended,
    DIGESTIF_TEXMF: pathListJoin(texmfDirs),
  };

  // Help LuaTeX-based Digestif wrappers find the LMTX interpreter when present.
  const texlua =
    binDirs
      .map((d) => path.join(d, process.platform === 'win32' ? 'texlua.exe' : 'texlua'))
      .find((p) => isExecutable(p)) ??
    binDirs
      .map((d) => path.join(d, process.platform === 'win32' ? 'luametatex.exe' : 'luametatex'))
      .find((p) => isExecutable(p));
  if (texlua) {
    env.TEXLUA = texlua;
  }

  return {
    ok: true,
    digestifPath,
    interfaceXmlPath,
    texmfDirs,
    env,
    root,
  };
}
