import * as fs from 'node:fs';
import * as path from 'node:path';

/** Extensions tried when a ConTeXt include name has no suffix. */
export const TEX_INCLUDE_EXTENSIONS = [
  '.tex',
  '.mkiv',
  '.mkxl',
  '.mkvi',
  '.mklx',
  '.cld',
  '.lua',
  '.ctx',
] as const;

/** Common image extensions for `\\externalfigure`. */
export const FIGURE_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.jp2',
  '.svg',
  '.eps',
  '.tif',
  '.tiff',
  '.gif',
] as const;

export interface ResolveIncludeOptions {
  /** Absolute path of the file that contains the include command. */
  fromFile: string;
  /** Raw name from the command (may include subpath or suffix). */
  name: string;
  /** Directories from `\\usepath[...]` relative to `fromFile` (or absolute). */
  usePaths?: string[];
  /** Extra search directories (parents, workspace folders, compile root). */
  searchDirs?: string[];
  /** Extensions to try when `name` has no suffix. */
  extensions?: readonly string[];
  /** Optional existence check (defaults to fs.existsSync file). */
  existsFile?: (absolutePath: string) => boolean;
}

function defaultExistsFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function hasKnownSuffix(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function candidateNames(name: string, extensions: readonly string[]): string[] {
  const trimmed = name.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) {
    return [];
  }
  if (hasKnownSuffix(trimmed, extensions)) {
    return [trimmed];
  }
  // ConTeXt often omits `.tex`; try bare name first only if it already looks absolute/relative with a suffix-like form.
  return [trimmed, ...extensions.map((ext) => `${trimmed}${ext}`)];
}

/**
 * Resolve a ConTeXt include / module / figure name to an absolute file path.
 *
 * Search order per candidate name:
 * 1. Absolute path as written
 * 2. Directory of `fromFile`
 * 3. Each `\\usepath` directory (resolved relative to `fromFile`)
 * 4. Extra `searchDirs` (parents, workspace folders, …)
 */
export function resolveIncludePath(opts: ResolveIncludeOptions): string | undefined {
  const exists = opts.existsFile ?? defaultExistsFile;
  const extensions = opts.extensions ?? TEX_INCLUDE_EXTENSIONS;
  const fromDir = path.dirname(opts.fromFile);
  const useDirs = (opts.usePaths ?? []).map((d) =>
    path.isAbsolute(d) ? d : path.resolve(fromDir, d),
  );
  const extra = opts.searchDirs ?? [];
  const dirs = [fromDir, ...useDirs, ...extra];

  const names = candidateNames(opts.name, extensions);
  for (const n of names) {
    if (path.isAbsolute(n) && exists(n)) {
      return n;
    }
    const seen = new Set<string>();
    for (const dir of dirs) {
      const key = path.resolve(dir);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const abs = path.resolve(dir, n);
      if (exists(abs)) {
        return abs;
      }
      // Wiki §5 product layout: `\product book-one` → book-one/book-one.tex
      // (bare stem only — skip when the name already has a path).
      if (!/[\\/]/.test(n)) {
        const stem = hasKnownSuffix(n, extensions)
          ? n.slice(0, n.length - path.extname(n).length)
          : n;
        if (stem) {
          const nested = hasKnownSuffix(n, extensions)
            ? [path.resolve(dir, stem, n)]
            : [
                path.resolve(dir, stem, stem),
                ...extensions.map((ext) => path.resolve(dir, stem, `${stem}${ext}`)),
              ];
          for (const cand of nested) {
            if (exists(cand)) {
              return cand;
            }
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Parent directories of `fromFile` up to `maxDepth` (excluding `fromFile`'s own dir
 * when already searched separately). Useful for environment/project lookup.
 */
export function parentSearchDirs(fromFile: string, maxDepth = 3): string[] {
  const dirs: string[] = [];
  let dir = path.dirname(fromFile);
  for (let i = 0; i < maxDepth; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dirs.push(parent);
    dir = parent;
  }
  return dirs;
}

/** Parse comma-separated `\\usepath[...]` body into directory strings. */
export function parseUsePathBody(body: string): string[] {
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
