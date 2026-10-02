import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentSearchDirs, resolveIncludePath } from './pathResolve';
import {
  scanStructure,
  type IncludeKind,
  type IncludeRef,
  type StructureRole,
  type StructureScanResult,
} from './structureScan';

/** Node kinds shown in the Project TreeView. */
export type ProjectNodeKind =
  | 'project'
  | 'product'
  | 'component'
  | 'environment'
  | 'input'
  | 'document'
  | 'missing'
  | 'message';

export interface ProjectNode {
  kind: ProjectNodeKind;
  /** Display name (basename or unresolved token). */
  label: string;
  /** Absolute path when resolved. */
  fsPath?: string;
  /** True when the include name did not resolve to a file. */
  missing: boolean;
  /** How many times this include was mentioned (deduped nodes). */
  mentionCount: number;
  children: ProjectNode[];
  /** Offset of `\\start…` / load command when known. */
  commandStart?: number;
  /** Prefer Expanded in the TreeView (multi-product). */
  preferExpand: boolean;
  /** Tooltip extras (searched dirs, include count, …). */
  detail?: string;
}

export interface ProjectModelOptions {
  /** Absolute path of the resolved root / entry file. */
  entryFile: string;
  /** Active editor path (prefer expand matching product). */
  activeFile?: string;
  workspaceFolders?: string[];
  /** Show `\\input` children (default false). */
  includeInputs?: boolean;
  /** Cap on files visited while expanding the graph. */
  maxFiles?: number;
  readFile?: (absolutePath: string) => string | undefined;
  existsFile?: (absolutePath: string) => boolean;
}

export interface ProjectModelResult {
  roots: ProjectNode[];
  entryFile: string;
  truncated: boolean;
  unresolvedCount: number;
  fileCount: number;
  timingsMs: { total: number };
  /** Empty / missing-root / no-structure copy for the TreeView. */
  emptyMessage?: string;
}

const STRUCTURE_LOAD_KINDS = new Set<IncludeKind>([
  'project',
  'product',
  'component',
  'environment',
  'input',
]);

function defaultReadFile(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultExistsFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function basenameLabel(fsPath: string, fallback: string): string {
  return path.basename(fsPath) || fallback;
}

function kindFromRole(role: StructureRole): ProjectNodeKind {
  return role;
}

interface WalkState {
  visited: Set<string>;
  fileCount: number;
  maxFiles: number;
  truncated: boolean;
  unresolvedCount: number;
  includeInputs: boolean;
  workspaceFolders: string[];
  preferredProductPath?: string;
  readFile: (p: string) => string | undefined;
  existsFile: (p: string) => boolean;
}

function searchDirsFor(fromFile: string, folders: string[]): string[] {
  return [...parentSearchDirs(fromFile, 3), ...folders];
}

function resolveName(
  fromFile: string,
  name: string,
  usePaths: string[],
  state: WalkState,
): string | undefined {
  return resolveIncludePath({
    fromFile,
    name,
    usePaths,
    searchDirs: searchDirsFor(fromFile, state.workspaceFolders),
    existsFile: state.existsFile,
  });
}

function makeMissing(
  kind: ProjectNodeKind,
  name: string,
  detail?: string,
): ProjectNode {
  return {
    kind: 'missing',
    label: name,
    missing: true,
    mentionCount: 1,
    children: [],
    preferExpand: false,
    detail: detail ?? `Unresolved ${kind}: ${name}`,
  };
}

function makeNode(
  kind: ProjectNodeKind,
  label: string,
  fsPath: string | undefined,
  opts: Partial<ProjectNode> = {},
): ProjectNode {
  return {
    kind,
    label,
    fsPath,
    missing: false,
    mentionCount: 1,
    children: [],
    preferExpand: false,
    ...opts,
  };
}

/**
 * Expand children of a product (or document that lists structure loads).
 * Deduplicates repeated `\\component` / same-path includes to one node.
 * Does not expand `\\component` found inside environment files.
 */
function expandStructureChildren(
  fromFile: string,
  scan: StructureScanResult,
  state: WalkState,
  opts: {
    /** When expanding a project file, skip re-expanding this product path. */
    skipProductPath?: string;
    /** Only collect these include kinds (defaults: component, environment, + input). */
    kinds?: Set<IncludeKind>;
    /** If true, recurse into product/component files for their children. */
    recurseProducts?: boolean;
    /** Environment files: only follow nested environments, not components. */
    insideEnvironment?: boolean;
  } = {},
): ProjectNode[] {
  const kinds =
    opts.kinds ??
    new Set<IncludeKind>(
      opts.insideEnvironment
        ? ['environment']
        : (['component', 'environment', ...(state.includeInputs ? (['input'] as const) : [])] as IncludeKind[]),
    );

  // Dedup key → node
  const byKey = new Map<string, ProjectNode>();
  const order: string[] = [];

  for (const inc of scan.includes) {
    if (!STRUCTURE_LOAD_KINDS.has(inc.kind)) {
      continue;
    }
    if (!kinds.has(inc.kind)) {
      continue;
    }
    if (opts.insideEnvironment && inc.kind === 'component') {
      continue;
    }

    const resolved = resolveName(fromFile, inc.name, scan.usePaths, state);
    const key = resolved
      ? `${inc.kind}:${path.resolve(resolved)}`
      : `${inc.kind}:missing:${inc.name}`;

    const existing = byKey.get(key);
    if (existing) {
      existing.mentionCount += 1;
      existing.detail =
        existing.mentionCount > 1
          ? `Included ${existing.mentionCount} times`
          : existing.detail;
      continue;
    }

    if (!resolved) {
      state.unresolvedCount += 1;
      const node = makeMissing(inc.kind as ProjectNodeKind, inc.name, `Unresolved ${inc.kind}: ${inc.name}`);
      node.commandStart = inc.commandStart;
      byKey.set(key, node);
      order.push(key);
      continue;
    }

    if (opts.skipProductPath && path.resolve(resolved) === path.resolve(opts.skipProductPath)) {
      // Project ↔ product mutual reference: keep a leaf product node without
      // re-expanding the product we already walk from the entry side.
      const leaf = makeNode('product', basenameLabel(resolved, inc.name), resolved, {
        commandStart: inc.commandStart,
        preferExpand: false,
        detail: 'Same as entry product (not expanded twice)',
      });
      byKey.set(key, leaf);
      order.push(key);
      continue;
    }

    if (state.fileCount >= state.maxFiles) {
      state.truncated = true;
      break;
    }

    const nodeKind: ProjectNodeKind =
      inc.kind === 'input' ? 'input' : (inc.kind as ProjectNodeKind);
    const preferExpand =
      nodeKind === 'product' &&
      state.preferredProductPath != null &&
      path.resolve(resolved) === path.resolve(state.preferredProductPath);

    const node = makeNode(nodeKind, basenameLabel(resolved, inc.name), resolved, {
      commandStart: inc.commandStart,
      preferExpand,
    });

    // Recurse into products / components / environments as appropriate
    if (nodeKind === 'environment') {
      attachFileChildren(node, resolved, state, { insideEnvironment: true });
    } else if (nodeKind === 'component') {
      // Components are leaves for the product graph (content units). Nested
      // `\component` inside a component file is still shown (content can nest).
      attachFileChildren(node, resolved, state, {
        kinds: new Set(['component', 'environment', ...(state.includeInputs ? ['input' as const] : [])]),
      });
    } else if (nodeKind === 'product' && opts.recurseProducts !== false) {
      attachFileChildren(node, resolved, state, {});
    } else if (nodeKind === 'input') {
      // inputs are leaves unless we want deep chains; keep leaf for v1
    }

    byKey.set(key, node);
    order.push(key);
  }

  return order.map((k) => byKey.get(k)!);
}

function attachFileChildren(
  parent: ProjectNode,
  filePath: string,
  state: WalkState,
  opts: {
    kinds?: Set<IncludeKind>;
    insideEnvironment?: boolean;
    skipProductPath?: string;
    recurseProducts?: boolean;
  },
): void {
  const abs = path.resolve(filePath);
  if (state.visited.has(abs)) {
    return;
  }
  if (state.fileCount >= state.maxFiles) {
    state.truncated = true;
    return;
  }
  state.visited.add(abs);
  state.fileCount += 1;

  const text = state.readFile(abs);
  if (text == null) {
    parent.missing = true;
    parent.kind = 'missing';
    parent.detail = `Could not read ${abs}`;
    state.unresolvedCount += 1;
    return;
  }

  const scan = scanStructure(text);
  parent.children = expandStructureChildren(abs, scan, state, opts);
}

function buildProductNode(
  productPath: string,
  state: WalkState,
  scanHint?: StructureScanResult,
): ProjectNode {
  const abs = path.resolve(productPath);
  const text = scanHint ? undefined : state.readFile(abs);
  const scan = scanHint ?? (text != null ? scanStructure(text) : undefined);
  const label =
    scan?.fileRole?.name ??
    basenameLabel(abs, path.basename(abs));
  const node = makeNode('product', label, abs, {
    commandStart: scan?.fileRole?.commandStart,
    preferExpand: true,
  });

  if (state.visited.has(abs)) {
    return node;
  }
  if (state.fileCount >= state.maxFiles) {
    state.truncated = true;
    return node;
  }
  state.visited.add(abs);
  state.fileCount += 1;

  if (!scan) {
    node.missing = true;
    node.kind = 'missing';
    node.detail = `Could not read ${abs}`;
    state.unresolvedCount += 1;
    return node;
  }

  node.children = expandStructureChildren(abs, scan, state, {});
  return node;
}

function buildProjectTree(
  projectPath: string,
  entryProductPath: string | undefined,
  state: WalkState,
): ProjectNode {
  const abs = path.resolve(projectPath);
  const text = state.readFile(abs);
  const label = basenameLabel(abs, path.basename(abs));
  const projectNode = makeNode('project', label, abs, { preferExpand: true });

  if (text == null) {
    projectNode.missing = true;
    projectNode.kind = 'missing';
    projectNode.detail = `Could not read ${abs}`;
    state.unresolvedCount += 1;
    return projectNode;
  }

  if (state.fileCount >= state.maxFiles) {
    state.truncated = true;
    return projectNode;
  }
  state.visited.add(abs);
  state.fileCount += 1;

  const scan = scanStructure(text);
  if (scan.fileRole?.name) {
    projectNode.label = scan.fileRole.name;
  }
  projectNode.commandStart = scan.fileRole?.commandStart;

  // Shared environments on the project, then products.
  const envChildren = expandStructureChildren(abs, scan, state, {
    kinds: new Set(['environment']),
  });

  const productChildren: ProjectNode[] = [];
  const productIncludes = scan.includes.filter((i) => i.kind === 'product');
  const seenProducts = new Set<string>();

  for (const inc of productIncludes) {
    const resolved = resolveName(abs, inc.name, scan.usePaths, state);
    if (!resolved) {
      state.unresolvedCount += 1;
      productChildren.push(
        makeMissing('product', inc.name, `Unresolved product: ${inc.name}`),
      );
      continue;
    }
    const rAbs = path.resolve(resolved);
    if (seenProducts.has(rAbs)) {
      const existing = productChildren.find((c) => c.fsPath === rAbs);
      if (existing) {
        existing.mentionCount += 1;
        existing.detail = `Included ${existing.mentionCount} times`;
      }
      continue;
    }
    seenProducts.add(rAbs);

    const isPreferred =
      state.preferredProductPath != null &&
      rAbs === path.resolve(state.preferredProductPath);

    if (entryProductPath && rAbs === path.resolve(entryProductPath)) {
      // Expand entry product fully (already may be partially visited — clear
      // visit for children expansion via dedicated builder).
      state.visited.delete(rAbs);
      const productNode = buildProductNode(rAbs, state);
      productNode.preferExpand = true;
      productChildren.push(productNode);
      continue;
    }

    if (isPreferred) {
      state.visited.delete(rAbs);
      const productNode = buildProductNode(rAbs, state);
      productNode.preferExpand = true;
      productChildren.push(productNode);
      continue;
    }

    // Other products: leaf or shallow (collapsed in UI).
    if (state.fileCount >= state.maxFiles) {
      state.truncated = true;
      productChildren.push(
        makeNode('product', basenameLabel(rAbs, inc.name), rAbs, {
          preferExpand: false,
          commandStart: inc.commandStart,
        }),
      );
      continue;
    }
    state.fileCount += 1;
    productChildren.push(
      makeNode('product', basenameLabel(rAbs, inc.name), rAbs, {
        preferExpand: false,
        commandStart: inc.commandStart,
        detail: 'Collapsed (not the active / root product)',
      }),
    );
  }

  // If entry product was not listed on the project file, still attach it.
  if (entryProductPath) {
    const eAbs = path.resolve(entryProductPath);
    if (!seenProducts.has(eAbs)) {
      state.visited.delete(eAbs);
      const productNode = buildProductNode(eAbs, state);
      productNode.preferExpand = true;
      productChildren.unshift(productNode);
    }
  }

  projectNode.children = [...envChildren, ...productChildren];
  return projectNode;
}

function findProjectInclude(scan: StructureScanResult): IncludeRef | undefined {
  return scan.includes.find((i) => i.kind === 'project');
}

/**
 * Build the ConTeXt project / product / component / environment graph starting
 * from a resolved root file. Pure TypeScript (no `vscode` import).
 */
export function buildProjectModel(opts: ProjectModelOptions): ProjectModelResult {
  const started = Date.now();
  const entryFile = path.resolve(opts.entryFile);
  const readFile = opts.readFile ?? defaultReadFile;
  const existsFile = opts.existsFile ?? defaultExistsFile;
  const maxFiles = opts.maxFiles ?? 500;
  const includeInputs = opts.includeInputs ?? false;
  const workspaceFolders = opts.workspaceFolders ?? [];

  if (!existsFile(entryFile)) {
    return {
      roots: [
        makeNode('message', 'Missing root file', undefined, {
          missing: false,
          detail: entryFile,
          preferExpand: false,
        }),
      ],
      entryFile,
      truncated: false,
      unresolvedCount: 1,
      fileCount: 0,
      timingsMs: { total: Date.now() - started },
      emptyMessage: `Root file not found: ${entryFile}. Set context.rootFile or open a ConTeXt source file.`,
    };
  }

  // Prefer expanding the resolved root product (`context.rootFile` / resolveRootFile).
  // When the active editor is itself a different product file under the same
  // project, prefer that product instead.
  let preferredProductPath = entryFile;
  if (opts.activeFile && existsFile(opts.activeFile)) {
    const activeAbs = path.resolve(opts.activeFile);
    if (activeAbs !== entryFile) {
      const activeText = readFile(activeAbs);
      const activeRole = activeText ? scanStructure(activeText).fileRole?.role : undefined;
      if (activeRole === 'product') {
        preferredProductPath = activeAbs;
      }
    }
  }

  const state: WalkState = {
    visited: new Set(),
    fileCount: 0,
    maxFiles,
    truncated: false,
    unresolvedCount: 0,
    includeInputs,
    workspaceFolders,
    preferredProductPath,
    readFile,
    existsFile,
  };

  const entryText = readFile(entryFile);
  if (entryText == null) {
    return {
      roots: [],
      entryFile,
      truncated: false,
      unresolvedCount: 1,
      fileCount: 0,
      timingsMs: { total: Date.now() - started },
      emptyMessage: `Could not read root file: ${entryFile}`,
    };
  }

  const entryScan = scanStructure(entryText);
  const role = entryScan.fileRole?.role;

  // Entry is a project file
  if (role === 'project') {
    state.preferredProductPath = preferredProductPath;
    const root = buildProjectTree(entryFile, undefined, state);
    // Prefer expand product matching active/entry setting
    for (const child of root.children) {
      if (child.kind === 'product' && child.fsPath) {
        const match =
          path.resolve(child.fsPath) === path.resolve(entryFile) ||
          (opts.activeFile != null &&
            path.resolve(child.fsPath) === path.resolve(opts.activeFile)) ||
          (state.preferredProductPath != null &&
            path.resolve(child.fsPath) === path.resolve(state.preferredProductPath));
        child.preferExpand = match || child.preferExpand;
      }
    }
    // If none preferred, expand first product
    if (!root.children.some((c) => c.kind === 'product' && c.preferExpand)) {
      const firstProduct = root.children.find((c) => c.kind === 'product');
      if (firstProduct) {
        if (firstProduct.fsPath && firstProduct.children.length === 0) {
          state.visited.delete(path.resolve(firstProduct.fsPath));
          const expanded = buildProductNode(firstProduct.fsPath, state);
          firstProduct.children = expanded.children;
          firstProduct.label = expanded.label;
        }
        firstProduct.preferExpand = true;
      }
    }
    return finish(root, entryFile, state, started);
  }

  // Entry is a product (or file that loads structure like a product)
  if (role === 'product' || hasProductLikeLoads(entryScan)) {
    const projectInc = findProjectInclude(entryScan);
    if (projectInc) {
      const projectPath = resolveName(entryFile, projectInc.name, entryScan.usePaths, state);
      if (projectPath) {
        state.preferredProductPath = entryFile;
        const root = buildProjectTree(projectPath, entryFile, state);
        return finish(root, entryFile, state, started);
      }
      state.unresolvedCount += 1;
    }
    state.preferredProductPath = entryFile;
    // Re-scan path: buildProductNode will re-read; pass scan to avoid double work
    state.visited.delete(entryFile);
    const product = buildProductNode(entryFile, state, entryScan);
    product.preferExpand = true;
    return finish(product, entryFile, state, started);
  }

  // Component / environment / plain document
  if (role === 'component' || role === 'environment') {
    const node = makeNode(kindFromRole(role), entryScan.fileRole?.name ?? basenameLabel(entryFile, role), entryFile, {
      commandStart: entryScan.fileRole?.commandStart,
      preferExpand: true,
    });
    if (role === 'environment') {
      attachFileChildren(node, entryFile, state, { insideEnvironment: true });
    } else {
      attachFileChildren(node, entryFile, state, {});
    }
    return finish(node, entryFile, state, started);
  }

  // No structure role: single document node (optional inputs)
  if (entryScan.includes.length === 0 && entryScan.usePaths.length === 0) {
    const doc = makeNode('document', basenameLabel(entryFile, 'document'), entryFile, {
      preferExpand: false,
    });
    return {
      roots: [doc],
      entryFile,
      truncated: false,
      unresolvedCount: 0,
      fileCount: 1,
      timingsMs: { total: Date.now() - started },
      emptyMessage:
        'No ConTeXt product or project found. Open a .tex / .mkiv file with \\startproduct / \\startproject, set context.rootFile, or run ConTeXt: New Project Structure…',
    };
  }

  // Has includes but no start role — treat as product-like document
  state.preferredProductPath = entryFile;
  state.visited.delete(entryFile);
  const docProduct = buildProductNode(entryFile, state, entryScan);
  docProduct.kind = entryScan.includes.some((i) => i.kind === 'component' || i.kind === 'environment')
    ? 'product'
    : 'document';
  docProduct.preferExpand = true;
  return finish(docProduct, entryFile, state, started);
}

function hasProductLikeLoads(scan: StructureScanResult): boolean {
  return scan.includes.some(
    (i) => i.kind === 'component' || i.kind === 'environment' || i.kind === 'product',
  );
}

function finish(
  root: ProjectNode,
  entryFile: string,
  state: WalkState,
  started: number,
): ProjectModelResult {
  return {
    roots: [root],
    entryFile,
    truncated: state.truncated,
    unresolvedCount: state.unresolvedCount,
    fileCount: state.fileCount,
    timingsMs: { total: Date.now() - started },
  };
}
