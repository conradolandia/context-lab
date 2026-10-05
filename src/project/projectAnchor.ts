import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveRootFile,
  resolveComponentProduct,
  resolveRootFileSetting,
} from './rootFile';
import { scanStructure, type StructureScanResult } from './structureScan';

export interface ProjectAnchorOptions {
  /** Absolute path of the active editor file, if any. */
  activeFile?: string;
  /** Contents of the active file (for magic / structure). */
  activeText?: string;
  /** Setting `context.rootFile` (relative or absolute). */
  rootFileSetting?: string;
  workspaceFolders?: string[];
  /** Last successful tree entry (product or project file). */
  lastEntryFile?: string;
  /** Absolute paths present in the last good model (membership check). */
  lastGraphPaths?: ReadonlySet<string>;
  readFile?: (absolutePath: string) => string | undefined;
  existsFile?: (absolutePath: string) => boolean;
}

export interface ProjectAnchorResult {
  /** Absolute path to scan as the tree entry (product / project preferred). */
  entryFile: string;
  reason: string;
  /**
   * True when the active file is not in `lastGraphPaths` and the anchor was
   * kept from the last good model (do not wipe the tree).
   */
  outsideGraph: boolean;
}

function defaultRead(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when a scan looks like a product/project graph root (not a lone component). */
export function isStrongStructureRoot(scan: StructureScanResult): boolean {
  const role = scan.fileRole?.role;
  if (role === 'project' || role === 'product') {
    return true;
  }
  return scan.includes.some(
    (i) =>
      i.kind === 'component' ||
      i.kind === 'environment' ||
      i.kind === 'product' ||
      i.kind === 'project',
  );
}

/** Collect absolute fsPaths from a project model tree. */
export function collectGraphPaths(
  roots: Array<{ fsPath?: string; children: unknown[] }>,
): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: Array<{ fsPath?: string; children: unknown[] }>): void => {
    for (const n of nodes) {
      if (n.fsPath) {
        out.add(path.resolve(n.fsPath));
      }
      walk(n.children as Array<{ fsPath?: string; children: unknown[] }>);
    }
  };
  walk(roots);
  return out;
}

/**
 * Choose a stable Project TreeView entry file.
 *
 * Priority:
 * 1. `context.rootFile` when set
 * 2. Keep `lastEntryFile` when the active file is inside the last graph
 * 3. Keep `lastEntryFile` when the active file only resolves to a weak
 *    component/document root (or is unrelated) — do not collapse the tree
 * 4. Newly discovered product/project via `resolveRootFile` / structure scan
 */
export function resolveProjectAnchor(opts: ProjectAnchorOptions): ProjectAnchorResult | undefined {
  const folders = opts.workspaceFolders ?? [];
  const readFile = opts.readFile ?? defaultRead;
  const existsFile = opts.existsFile ?? defaultExists;
  const active = opts.activeFile ? path.resolve(opts.activeFile) : undefined;
  const lastEntry = opts.lastEntryFile ? path.resolve(opts.lastEntryFile) : undefined;
  const graph = opts.lastGraphPaths;

  const settingAbs = resolveRootFileSetting(
    opts.rootFileSetting ?? '',
    folders,
    active,
  );
  if (settingAbs) {
    const outside =
      active != null && graph != null && graph.size > 0 && !graph.has(active);
    return {
      entryFile: settingAbs,
      reason: 'setting:context.rootFile',
      outsideGraph: outside,
    };
  }

  if (active && graph?.has(active) && lastEntry) {
    return {
      entryFile: lastEntry,
      reason: 'anchor:active-in-graph',
      outsideGraph: false,
    };
  }

  // Discover from active file
  let discovered: string | undefined;
  let discoveredStrong = false;
  if (active && existsFile(active)) {
    const text = opts.activeText ?? readFile(active) ?? '';
    const resolved = resolveRootFile({
      activeFile: active,
      activeText: text,
      rootFileSetting: '',
      workspaceFolders: folders,
    });
    discovered = path.resolve(resolved.rootFile);

    // Component without \\product in-file: resolveRootFile falls back to active.
    // Prefer an explicit product mention when present.
    const productFromComponent = resolveComponentProduct(active, text, folders);
    if (productFromComponent) {
      discovered = path.resolve(productFromComponent);
    }

    const discText = discovered === active ? text : (readFile(discovered) ?? '');
    const scan = scanStructure(discText);
    discoveredStrong = isStrongStructureRoot(scan);
    // Lone \\startcomponent (no product loads) is weak even if resolveRootFile
    // returned the component itself.
    if (scan.fileRole?.role === 'component' && !discoveredStrong) {
      discoveredStrong = false;
    }
    if (discovered === active && scan.fileRole?.role === 'component') {
      discoveredStrong = false;
    }
  }

  if (discovered && discoveredStrong) {
    return {
      entryFile: discovered,
      reason: 'discover:product-or-project',
      outsideGraph: false,
    };
  }

  // Weak or missing discovery: keep last good entry if we have one.
  if (lastEntry && existsFile(lastEntry)) {
    const outside = active != null && (graph == null || !graph.has(active));
    return {
      entryFile: lastEntry,
      reason: discovered
        ? 'anchor:keep-last-weak-active'
        : 'anchor:keep-last-no-active',
      outsideGraph: outside,
    };
  }

  if (discovered) {
    return {
      entryFile: discovered,
      reason: 'fallback:active',
      outsideGraph: false,
    };
  }

  return undefined;
}
