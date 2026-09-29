import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CONTEXT_INTERFACE_REL,
  resolveInstallRoot,
  TEXMF_CONTEXT_REL,
} from '../toolchain/paths';
import { findLuarocksDigestif } from './digestifLaunch';
import type { DigestifResolveSource } from './digestifLaunch';

export { CONTEXT_INTERFACE_REL, TEXMF_CONTEXT_REL } from '../toolchain/paths';

export type DigestifEnvOk = {
  ok: true;
  digestifPath: string;
  source: DigestifResolveSource;
  interfaceXmlPath: string;
  texmfDirs: string[];
  /**
   * Env for the DigestiF child: user's environment plus DIGESTIF_* only.
   * Never prepends LMTX to PATH and never sets TEXMFCNF / TEXMF* / TEXLUA.
   */
  env: NodeJS.ProcessEnv;
  root: string;
};

export type DigestifEnvFail = {
  ok: false;
  kind: 'digestif-missing' | 'xml-missing';
  message: string;
};

export type DigestifEnvResult = DigestifEnvOk | DigestifEnvFail;

export interface BuildDigestifEnvOptions {
  root?: string;
  digestifPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  whichDigestif?: () => string | undefined;
  homedir?: string;
  findLuarocks?: () => string | undefined;
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

export type ResolvedDigestifExecutable = {
  path: string;
  source: DigestifResolveSource;
};

/**
 * Resolve DigestiF executable:
 * 1. context.digestifPath override
 * 2. ~/.luarocks/bin/digestif (preferred over TeX Live on PATH)
 * 3. `digestif` on PATH
 */
export function resolveDigestifExecutable(
  digestifPathSetting?: string,
  whichDigestif: () => string | undefined = () => which('digestif'),
  options?: {
    homedir?: string;
    findLuarocks?: () => string | undefined;
  },
): ResolvedDigestifExecutable | undefined {
  const override = digestifPathSetting?.trim();
  if (override) {
    return isExecutable(override) ? { path: override, source: 'override' } : undefined;
  }
  const luarocks =
    options?.findLuarocks?.() ?? findLuarocksDigestif(options?.homedir);
  if (luarocks) {
    return { path: luarocks, source: 'luarocks' };
  }
  const onPath = whichDigestif();
  if (onPath) {
    return { path: onPath, source: 'path' };
  }
  return undefined;
}

export function findContextInterfaceXml(root: string): string | undefined {
  if (!root) {
    return undefined;
  }
  const canonical = path.join(root, CONTEXT_INTERFACE_REL);
  if (fs.existsSync(canonical) && fs.statSync(canonical).isFile()) {
    return canonical;
  }
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
  // Shallow search under tex/
  const texDir = path.join(root, 'tex');
  if (!fs.existsSync(texDir)) {
    return undefined;
  }
  const stack = [texDir];
  let seen = 0;
  while (stack.length > 0 && seen < 4000) {
    const dir = stack.pop()!;
    seen += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === 'context-en.xml') {
        return full;
      }
      if (ent.isDirectory() && ent.name !== 'bin') {
        stack.push(full);
      }
    }
  }
  return undefined;
}

export function collectTexmfDirs(root: string, interfaceXmlPath?: string): string[] {
  const dirs: string[] = [];
  const push = (p: string) => {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      return;
    }
    if (path.basename(p) === 'bin') {
      return;
    }
    if (!dirs.includes(p)) {
      dirs.push(p);
    }
  };

  const texDir = path.join(root, 'tex');
  if (fs.existsSync(texDir)) {
    for (const name of fs.readdirSync(texDir)) {
      if (!name.startsWith('texmf')) {
        continue;
      }
      // Skip platform binary trees (texmf-linux-64, etc.)
      if (/^texmf-(linux|osx|mswin|freebsd|openbsd)/i.test(name)) {
        continue;
      }
      push(path.join(texDir, name));
    }
  }
  if (interfaceXmlPath) {
    const fromXml = texmfRootFromInterfaceXml(interfaceXmlPath);
    if (fromXml) {
      push(fromXml);
    }
  }
  return dirs;
}

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
 * User env + DIGESTIF_* only. Never prepends LMTX to PATH and never sets
 * TEXMFCNF / TEXMF* / TEXLUA (those pull TeX Live DigestiF into LMTX trees).
 */
export function createDigestifSpawnEnv(options: {
  baseEnv?: NodeJS.ProcessEnv;
  texmfDirs: string[];
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
  if (options.texmfDirs.length > 0) {
    env.DIGESTIF_TEXMF = pathListJoin(options.texmfDirs);
  }
  return env;
}

/**
 * Resolve DigestiF binary + DIGESTIF_TEXMF for ConTeXt XML.
 * Does not start the process.
 */
export function buildDigestifEnv(options: BuildDigestifEnvOptions): DigestifEnvResult {
  const resolvedExe = resolveDigestifExecutable(
    options.digestifPath,
    options.whichDigestif ?? (() => which('digestif')),
    {
      homedir: options.homedir,
      findLuarocks: options.findLuarocks,
    },
  );

  if (!resolvedExe) {
    const hint = options.digestifPath?.trim()
      ? `context.digestifPath is set but not executable: ${options.digestifPath.trim()}`
      : 'Digestif not found. Install with: luarocks --local install digestif ' +
        '(put ~/.luarocks/bin on PATH), or set context.digestifPath.';
    return {
      ok: false,
      kind: 'digestif-missing',
      message: hint,
    };
  }

  const candidate = options.root?.trim() || undefined;
  if (!candidate) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        'ConTeXt interface XML not found: set context.root to your ConTeXt installation root ' +
        '(the directory that contains tex/, example: /path/to/context) so Digestif can load context-en.xml.',
    };
  }

  const root = resolveInstallRoot(candidate);
  if (!root) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        `Could not resolve a ConTeXt installation root from ${candidate}. ` +
        `Set context.root to the parent of tex/ (example: /path/to/context), not the bin folder. ` +
        `Expected ${path.join('…', CONTEXT_INTERFACE_REL)}.`,
    };
  }

  const interfaceXmlPath = findContextInterfaceXml(root);
  if (!interfaceXmlPath) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        `ConTeXt interface XML (context-en.xml) not found under install root ${root}. ` +
        `Expected ${path.join(root, CONTEXT_INTERFACE_REL)}. ` +
        `Check context.root points at the ConTeXt installation root (parent of tex/), not …/tex/texmf-*/bin.`,
    };
  }

  if (interfaceXmlPath.split(path.sep).includes('bin')) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        `Refusing interface XML path under a bin/ directory: ${interfaceXmlPath}. ` +
        `Set context.root to the ConTeXt installation root (e.g. /path/to/context).`,
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

  const env = createDigestifSpawnEnv({
    baseEnv: options.baseEnv,
    texmfDirs,
  });

  return {
    ok: true,
    digestifPath: resolvedExe.path,
    source: resolvedExe.source,
    interfaceXmlPath,
    texmfDirs,
    env,
    root,
  };
}
