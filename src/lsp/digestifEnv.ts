import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  candidateBinDirs,
  CONTEXT_INTERFACE_REL,
  resolveInstallRoot,
  TEXMF_CONTEXT_REL,
} from '../toolchain/paths';
import { writeTexluaLuaonlyShim, findLuarocksDigestif, isDigestifCheckoutHome } from './digestifLaunch';
import type { DigestifResolveSource } from './digestifLaunch';

export { CONTEXT_INTERFACE_REL, TEXMF_CONTEXT_REL } from '../toolchain/paths';

export type DigestifEnvOk = {
  ok: true;
  digestifPath: string;
  /** How digestifPath was chosen (drives launch: direct vs bootstrap). */
  source: DigestifResolveSource;
  interfaceXmlPath: string;
  /** Absolute texmf roots passed to DIGESTIF_TEXMF (colon/semicolon-separated). */
  texmfDirs: string[];
  /** Merged process env for the Digestif child. */
  env: NodeJS.ProcessEnv;
  /** Normalized LMTX install root (parent of tex/). */
  root: string;
  /** Absolute luametatex when found under the install root. */
  luametatex?: string;
  /** Absolute texlua when found (real binary, not our shim). */
  texlua?: string;
  /** DigestiF home for checkout / self-install. */
  digestifHome?: string;
};

export type DigestifEnvFail = {
  ok: false;
  kind: 'digestif-missing' | 'xml-missing';
  message: string;
};

export type DigestifEnvResult = DigestifEnvOk | DigestifEnvFail;

export interface BuildDigestifEnvOptions {
  /**
   * Candidate LMTX install root (from context.root or inferred).
   * May be a bin/texmf path; will be walked up to the install root.
   */
  root?: string;
  /** Absolute override for the Digestif executable (context.digestifPath). */
  digestifPath?: string;
  /** Base env to merge into (defaults to process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Injected which() for tests. */
  whichDigestif?: () => string | undefined;
  /**
   * Absolute path to resources/digestif-lmtx-bootstrap.lua.
   * Passed into the texlua shim so wrapper launches use the path searcher.
   */
  bootstrapPath?: string;
  /** Injected homedir for tests. */
  homedir?: string;
  /** Injected luarocks digestif finder for tests. */
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
  digestifHome?: string;
};

/**
 * Resolve DigestiF executable in Sir's order:
 * 1. context.digestifPath override
 * 2. `digestif` on PATH
 * 3. ~/.luarocks/bin/digestif
 * 4. ~/.digestif checkout (caller launches via LMTX bootstrap)
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
  const onPath = whichDigestif();
  if (onPath) {
    return { path: onPath, source: 'path' };
  }
  const luarocks =
    options?.findLuarocks?.() ?? findLuarocksDigestif(options?.homedir);
  if (luarocks) {
    return { path: luarocks, source: 'luarocks' };
  }
  const home = path.join(options?.homedir ?? os.homedir(), '.digestif');
  if (isDigestifCheckoutHome(home)) {
    const bin = path.join(home, 'bin', 'digestif');
    return {
      path: fs.existsSync(bin) ? bin : home,
      source: 'checkout-bootstrap',
      digestifHome: home,
    };
  }
  return undefined;
}

/**
 * Locate context-en.xml under an LMTX-style install root.
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
 * Prefers texmf-context and sibling content trees under {root}/tex.
 * Never includes a bare bin/ directory.
 */
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
    // Prefer content tree first
    push(path.join(texDir, 'texmf-context'));
    try {
      for (const name of fs.readdirSync(texDir)) {
        if (!name.startsWith('texmf-')) {
          continue;
        }
        // Skip platform binary-only trees (texmf-linux-64, etc.) which hold bin/
        // but not ConTeXt interface XML. Digestif only needs content texmf trees.
        if (/^texmf-(linux|osx|mswin|windows)/i.test(name)) {
          continue;
        }
        push(path.join(texDir, name));
      }
    } catch {
      // ignore
    }
  }

  push(path.join(root, 'texmf-context'));

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
      : 'Digestif not found. Prefer: luarocks --local --lua-version 5.4 install digestif ' +
        '(and put ~/.luarocks/bin on PATH), or set context.digestifPath. ' +
        'Fallback: a ~/.digestif checkout with LMTX bootstrap.';
    return {
      ok: false,
      kind: 'digestif-missing',
      message: hint,
    };
  }

  const digestifPath = resolvedExe.path;
  const source = resolvedExe.source;
  const digestifHome =
    resolvedExe.digestifHome ??
    (isDigestifCheckoutHome(path.join(options.homedir ?? os.homedir(), '.digestif'))
      ? path.join(options.homedir ?? os.homedir(), '.digestif')
      : undefined);

  const candidate = options.root?.trim() || undefined;
  if (!candidate) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        'ConTeXt interface XML not found: set context.root to your LMTX install root ' +
        '(the directory that contains tex/, example: /home/andi/Apps/lmtx) so Digestif can load context-en.xml.',
    };
  }

  const root = resolveInstallRoot(candidate);
  if (!root) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        `Could not resolve an LMTX install root from ${candidate}. ` +
        `Set context.root to the parent of tex/ (example: /home/andi/Apps/lmtx), not the bin folder. ` +
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
        `Check context.root points at the LMTX install root (parent of tex/), not …/tex/texmf-*/bin.`,
    };
  }

  // Guard: never accept an XML path that lives under a bin/ segment
  if (interfaceXmlPath.split(path.sep).includes('bin')) {
    return {
      ok: false,
      kind: 'xml-missing',
      message:
        `Refusing interface XML path under a bin/ directory: ${interfaceXmlPath}. ` +
        `Set context.root to the LMTX install root (e.g. /home/andi/Apps/lmtx).`,
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

  const texluaName = process.platform === 'win32' ? 'texlua.exe' : 'texlua';
  const luametaName = process.platform === 'win32' ? 'luametatex.exe' : 'luametatex';
  const realTexlua = binDirs.map((d) => path.join(d, texluaName)).find((p) => isExecutable(p));
  const luametatex = binDirs.map((d) => path.join(d, luametaName)).find((p) => isExecutable(p));

  // Only install texlua→luametatex shim when we may fall back to checkout bootstrap.
  const pathPrefix = [...binDirs];
  let texluaShimDir: string | undefined;
  if (source === 'checkout-bootstrap' && !realTexlua && luametatex) {
    const shim = writeTexluaLuaonlyShim(
      luametatex,
      undefined,
      options.bootstrapPath,
    );
    if (shim) {
      texluaShimDir = shim.shimDir;
      pathPrefix.unshift(shim.shimDir);
    }
  }

  const prepended = [...pathPrefix, existingPath].filter(Boolean).join(pathSep);

  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: prepended,
    DIGESTIF_TEXMF: pathListJoin(texmfDirs),
  };

  if (digestifHome) {
    env.DIGESTIF_HOME = digestifHome;
    const data = path.join(digestifHome, 'data');
    if (fs.existsSync(data)) {
      env.DIGESTIF_DATA = data;
    }
  }

  if (luametatex) {
    env.TEXLUA = realTexlua ?? (texluaShimDir
      ? path.join(texluaShimDir, process.platform === 'win32' ? 'texlua.cmd' : 'texlua')
      : luametatex);
  } else if (realTexlua) {
    env.TEXLUA = realTexlua;
  }

  return {
    ok: true,
    digestifPath,
    source,
    interfaceXmlPath,
    texmfDirs,
    env,
    root,
    luametatex,
    texlua: realTexlua,
    digestifHome,
  };
}
