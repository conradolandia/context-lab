import * as fs from 'node:fs';
import * as path from 'node:path';

export type RootRule =
  | 'setting:context.rootFile'
  | 'magic:% !TEX root'
  | 'structure:component→product'
  | 'fallback:active';

export interface RootResolution {
  rootFile: string;
  rule: RootRule;
}

const MAGIC_ROOT =
  /^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$/i;
const START_COMPONENT = /\\startcomponent\b/;
const PRODUCT_CMD = /\\product\s+\{?([^\s\}%]+)\}?/;

function existsTex(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function withTexExt(name: string): string[] {
  if (/\.(tex|ctx|mkiv|mkxl)$/i.test(name)) {
    return [name];
  }
  return [`${name}.tex`, `${name}.ctx`, `${name}.mkiv`, `${name}.mkxl`];
}

function resolveCandidate(baseDir: string, name: string): string | undefined {
  for (const n of withTexExt(name.trim())) {
    const abs = path.resolve(baseDir, n);
    if (existsTex(abs)) {
      return abs;
    }
  }
  return undefined;
}

/** Parse `% !TEX root = …` from the first `maxLines` of text. */
export function parseMagicRoot(
  text: string,
  activeFile: string,
  maxLines = 20,
): string | undefined {
  const lines = text.split(/\r?\n/).slice(0, maxLines);
  for (const line of lines) {
    const m = MAGIC_ROOT.exec(line);
    if (m) {
      const raw = m[1].replace(/^["']|["']$/g, '').trim();
      if (!raw) {
        continue;
      }
      const abs = path.isAbsolute(raw)
        ? raw
        : path.resolve(path.dirname(activeFile), raw);
      if (existsTex(abs)) {
        return abs;
      }
      // Still return resolved path even if missing — caller may warn
      return abs;
    }
  }
  return undefined;
}

/**
 * If active is a `\startcomponent`, find `\product <name>` and resolve
 * `<name>.tex`. Stop at the product even if it has `\project` (compile product).
 */
export function resolveComponentProduct(
  activeFile: string,
  text: string,
  workspaceFolders: string[] = [],
): string | undefined {
  if (!START_COMPONENT.test(text)) {
    return undefined;
  }
  const m = PRODUCT_CMD.exec(text);
  if (!m) {
    return undefined;
  }
  const productName = m[1];
  const dir = path.dirname(activeFile);
  const searchDirs = [
    dir,
    path.dirname(dir),
    path.dirname(path.dirname(dir)),
    ...workspaceFolders,
  ];
  const seen = new Set<string>();
  for (const d of searchDirs) {
    const key = path.resolve(d);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const hit = resolveCandidate(d, productName);
    if (hit) {
      // Product file is the compile root; a \\project directive does not change it.
      return hit;
    }
  }
  return undefined;
}

export interface ResolveRootOptions {
  /** Absolute path of the active editor file. */
  activeFile: string;
  /** Contents of the active file (for magic / structure). */
  activeText: string;
  /** Setting context.rootFile (may be relative or absolute). */
  rootFileSetting?: string;
  /** Workspace folder paths for relative setting + product search. */
  workspaceFolders?: string[];
}

/**
 * Resolve `context.rootFile` (relative or absolute) to an absolute path.
 * Relative paths use the first workspace folder, else the active file's directory.
 */
export function resolveRootFileSetting(
  setting: string,
  workspaceFolders: string[],
  activeFile?: string,
): string | undefined {
  const s = setting.trim();
  if (!s) {
    return undefined;
  }
  if (path.isAbsolute(s)) {
    return path.resolve(s);
  }
  if (workspaceFolders.length > 0) {
    return path.resolve(workspaceFolders[0], s);
  }
  if (activeFile) {
    return path.resolve(path.dirname(activeFile), s);
  }
  return path.resolve(s);
}

/**
 * Resolve the ConTeXt main/root file to compile.
 * Order: setting → magic comment → component→product → active file.
 */
export function resolveRootFile(opts: ResolveRootOptions): RootResolution {
  const folders = opts.workspaceFolders ?? [];
  const settingAbs = resolveRootFileSetting(
    opts.rootFileSetting ?? '',
    folders,
    opts.activeFile,
  );

  if (settingAbs) {
    return { rootFile: settingAbs, rule: 'setting:context.rootFile' };
  }

  const magic = parseMagicRoot(opts.activeText, opts.activeFile);
  if (magic) {
    return { rootFile: magic, rule: 'magic:% !TEX root' };
  }

  const product = resolveComponentProduct(
    opts.activeFile,
    opts.activeText,
    folders,
  );
  if (product) {
    return { rootFile: product, rule: 'structure:component→product' };
  }

  return { rootFile: opts.activeFile, rule: 'fallback:active' };
}
