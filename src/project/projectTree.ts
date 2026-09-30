import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildProjectModel,
  type ProjectModelResult,
  type ProjectNode,
} from './projectModel';
import {
  collectGraphPaths,
  isStrongStructureRoot,
  resolveProjectAnchor,
} from './projectAnchor';
import { treeId } from './projectTreeIds';
import { scanStructure } from './structureScan';
import { logDebug } from '../outputLog';
import * as fs from 'node:fs';

export { collectTreeIds, localTreeId, treeId } from './projectTreeIds';

export const PROJECT_VIEW_ID = 'context.projectView';

/** Context values for menus / when-clauses. */
export type ProjectTreeContextValue =
  | 'context.projectNode.project'
  | 'context.projectNode.product'
  | 'context.projectNode.component'
  | 'context.projectNode.environment'
  | 'context.projectNode.input'
  | 'context.projectNode.document'
  | 'context.projectNode.missing'
  | 'context.projectNode.message';

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: ProjectNode,
    collapsible: vscode.TreeItemCollapsibleState,
    /** Full tree id of the parent occurrence; omit for roots. */
    parentId?: string,
  ) {
    super(node.label, collapsible);
    this.tooltip = buildTooltip(node);
    this.description = describeNode(node);
    this.contextValue = contextValueFor(node);
    this.iconPath = iconFor(node);
    this.id = treeId(node, parentId);

    if (node.fsPath && !node.missing && node.kind !== 'message') {
      this.resourceUri = vscode.Uri.file(node.fsPath);
      this.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(node.fsPath)],
      };
    }
  }
}

/** Parent lookup: child occurrence id → parent node + id arg for ProjectTreeItem. */
type ParentRef = { parent: ProjectNode; parentId?: string };

function contextValueFor(node: ProjectNode): ProjectTreeContextValue {
  switch (node.kind) {
    case 'project':
      return 'context.projectNode.project';
    case 'product':
      return 'context.projectNode.product';
    case 'component':
      return 'context.projectNode.component';
    case 'environment':
      return 'context.projectNode.environment';
    case 'input':
      return 'context.projectNode.input';
    case 'document':
      return 'context.projectNode.document';
    case 'missing':
      return 'context.projectNode.missing';
    case 'message':
      return 'context.projectNode.message';
  }
}

function iconFor(node: ProjectNode): vscode.ThemeIcon {
  if (node.missing || node.kind === 'missing') {
    return new vscode.ThemeIcon('warning');
  }
  switch (node.kind) {
    case 'project':
      return new vscode.ThemeIcon('symbol-namespace');
    case 'product':
      return new vscode.ThemeIcon('book');
    case 'component':
      return new vscode.ThemeIcon('file');
    case 'environment':
      return new vscode.ThemeIcon('settings-gear');
    case 'input':
      return new vscode.ThemeIcon('file-symlink-file');
    case 'document':
      return new vscode.ThemeIcon('file');
    case 'message':
      return new vscode.ThemeIcon('info');
    default:
      return new vscode.ThemeIcon('file');
  }
}

function describeNode(node: ProjectNode): string | undefined {
  if (node.kind === 'message') {
    return undefined;
  }
  const bits: string[] = [];
  if (node.kind !== 'missing') {
    bits.push(node.kind);
  }
  if (node.mentionCount > 1) {
    bits.push(`×${node.mentionCount}`);
  }
  return bits.length ? bits.join(' ') : undefined;
}

function buildTooltip(node: ProjectNode): string {
  const lines: string[] = [];
  if (node.fsPath) {
    lines.push(node.fsPath);
  }
  lines.push(`role: ${node.kind}`);
  if (node.mentionCount > 1) {
    lines.push(`included ${node.mentionCount} times`);
  }
  if (node.detail) {
    lines.push(node.detail);
  }
  return lines.join('\n');
}

function collapsibleState(node: ProjectNode): vscode.TreeItemCollapsibleState {
  if (!node.children.length) {
    return vscode.TreeItemCollapsibleState.None;
  }
  if (node.preferExpand || node.kind === 'project') {
    return vscode.TreeItemCollapsibleState.Expanded;
  }
  return vscode.TreeItemCollapsibleState.Collapsed;
}

function isWeakModel(model: ProjectModelResult): boolean {
  if (model.roots.length === 0) {
    return true;
  }
  if (model.roots.length === 1) {
    const r = model.roots[0];
    if (r.kind === 'message' || r.kind === 'document') {
      return true;
    }
    if (r.kind === 'component' && r.children.length === 0) {
      return true;
    }
  }
  return false;
}

export interface ProjectTreeProviderDeps {
  workspaceFolderPaths: () => string[];
  activeTexPath: () => string | undefined;
  getRootFileSetting: () => string;
}

/**
 * TreeDataProvider for the ConTeXt Project view.
 *
 * The tree is anchored to a product/project root (`context.rootFile` or the
 * last discovered strong structure file). Focusing a component updates the
 * anchor/message only; it does not reveal or show the Project view.
 * Use `context.projectView.revealActive` to reveal on demand.
 */
export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ProjectTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private model: ProjectModelResult | undefined;
  /** Last non-weak model kept when the active file is outside the graph. */
  private lastGoodModel: ProjectModelResult | undefined;
  private anchoredEntry: string | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private treeView: vscode.TreeView<ProjectTreeItem> | undefined;
  /** child occurrence id → parent for reveal / getParent */
  private parentOf = new Map<string, ParentRef>();

  constructor(private readonly deps: ProjectTreeProviderDeps) {}

  setTreeView(view: vscode.TreeView<ProjectTreeItem>): void {
    this.treeView = view;
  }

  /** Full rescan from the current anchor (or rediscover). */
  refresh(): void {
    this.model = undefined;
    this.parentOf.clear();
    this._onDidChangeTreeData.fire();
  }

  scheduleRefresh(): void {
    const cfg = vscode.workspace.getConfiguration('context');
    const ms = cfg.get<number>('projectView.refreshDebounceMs', 300);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.refresh();
    }, Math.max(0, ms));
  }

  /**
   * Active-editor change: keep the anchored tree; only rebuild when the
   * resolved entry actually changes to a new strong product/project.
   * Does not call `treeView.reveal` — that would show/activate the Project
   * view container even with `focus: false`. Manual reveal stays on
   * `context.projectView.revealActive`.
   */
  onActiveEditorChanged(): void {
    const active = this.deps.activeTexPath();
    const folders = this.deps.workspaceFolderPaths();
    const graph = this.lastGoodModel
      ? collectGraphPaths(this.lastGoodModel.roots)
      : this.model
        ? collectGraphPaths(this.model.roots)
        : undefined;

    let activeText = '';
    if (active) {
      try {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === active);
        activeText = open ? open.getText() : fs.readFileSync(active, 'utf8');
      } catch {
        activeText = '';
      }
    }

    const anchor = resolveProjectAnchor({
      activeFile: active,
      activeText,
      rootFileSetting: this.deps.getRootFileSetting(),
      workspaceFolders: folders,
      lastEntryFile: this.anchoredEntry ?? this.lastGoodModel?.entryFile,
      lastGraphPaths: graph,
    });

    if (!anchor) {
      return;
    }

    const sameEntry =
      this.anchoredEntry != null &&
      path.resolve(anchor.entryFile) === path.resolve(this.anchoredEntry);

    if (sameEntry || (this.model && !anchor.outsideGraph && graph?.has(path.resolve(active ?? '')))) {
      this.applyOutsideMessage(anchor.outsideGraph, active);
      return;
    }

    // New strong root discovered (e.g. opened a different product) → rebuild.
    if (!sameEntry) {
      const text = readQuiet(anchor.entryFile);
      const strong = text ? isStrongStructureRoot(scanStructure(text)) : false;
      if (strong || this.deps.getRootFileSetting().trim()) {
        this.anchoredEntry = path.resolve(anchor.entryFile);
        this.refresh();
        return;
      }
    }

    // Weak / unrelated: keep current tree.
    this.applyOutsideMessage(true, active);
  }

  getModel(): ProjectModelResult | undefined {
    return this.model;
  }

  getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProjectTreeItem): ProjectTreeItem[] {
    if (!this.isEnabled()) {
      return [
        new ProjectTreeItem(
          {
            kind: 'message',
            label: 'Project view disabled (context.projectView.enabled)',
            missing: false,
            mentionCount: 1,
            children: [],
            preferExpand: false,
          },
          vscode.TreeItemCollapsibleState.None,
        ),
      ];
    }

    if (!element) {
      const result = this.ensureModel();
      if (result.emptyMessage && result.roots.every((r) => r.kind === 'document' || r.kind === 'message')) {
        if (result.roots.length === 1 && result.roots[0].kind === 'document') {
          return [
            new ProjectTreeItem(
              {
                kind: 'message',
                label: result.emptyMessage,
                missing: false,
                mentionCount: 1,
                children: [],
                preferExpand: false,
                detail: result.roots[0].fsPath,
              },
              vscode.TreeItemCollapsibleState.None,
            ),
            new ProjectTreeItem(result.roots[0], collapsibleState(result.roots[0])),
          ];
        }
      }
      if (result.emptyMessage && result.roots.length === 0) {
        return [
          new ProjectTreeItem(
            {
              kind: 'message',
              label: result.emptyMessage,
              missing: false,
              mentionCount: 1,
              children: [],
              preferExpand: false,
            },
            vscode.TreeItemCollapsibleState.None,
          ),
        ];
      }
      if (result.roots.length === 1 && result.roots[0].kind === 'message') {
        return [
          new ProjectTreeItem(
            {
              ...result.roots[0],
              label: result.emptyMessage ?? result.roots[0].label,
            },
            vscode.TreeItemCollapsibleState.None,
          ),
        ];
      }
      return result.roots.map((n) => new ProjectTreeItem(n, collapsibleState(n)));
    }
    const parentId = element.id;
    return element.node.children.map(
      (n) => new ProjectTreeItem(n, collapsibleState(n), parentId),
    );
  }

  getParent(element: ProjectTreeItem): ProjectTreeItem | undefined {
    const id = element.id;
    if (!id) {
      return undefined;
    }
    const ref = this.parentOf.get(id);
    if (!ref) {
      return undefined;
    }
    return new ProjectTreeItem(ref.parent, collapsibleState(ref.parent), ref.parentId);
  }

  async revealActive(): Promise<void> {
    const active = this.deps.activeTexPath();
    if (!active || !this.treeView) {
      return;
    }
    const result = this.ensureModel();
    const hit = findNodeOccurrence(result.roots, active);
    if (!hit) {
      return;
    }
    const item = new ProjectTreeItem(hit.node, collapsibleState(hit.node), hit.parentId);
    try {
      await this.treeView.reveal(item, { select: true, focus: false, expand: 2 });
    } catch {
      // reveal can fail if the element is not currently known to the view
    }
  }

  private applyOutsideMessage(outside: boolean, active: string | undefined): void {
    if (!this.treeView) {
      return;
    }
    if (outside && active) {
      this.treeView.message = `Active file is outside this project (${path.basename(active)}). Tree root unchanged.`;
    } else {
      this.treeView.message = undefined;
    }
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('context').get<boolean>('projectView.enabled', true);
  }

  private ensureModel(): ProjectModelResult {
    if (this.model) {
      return this.model;
    }
    const cfg = vscode.workspace.getConfiguration('context');
    const active = this.deps.activeTexPath();
    const folders = this.deps.workspaceFolderPaths();

    let activeText = '';
    if (active) {
      try {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === active);
        activeText = open ? open.getText() : fs.readFileSync(active, 'utf8');
      } catch {
        activeText = '';
      }
    }

    const graph = this.lastGoodModel
      ? collectGraphPaths(this.lastGoodModel.roots)
      : undefined;

    const anchor = resolveProjectAnchor({
      activeFile: active,
      activeText,
      rootFileSetting: this.deps.getRootFileSetting(),
      workspaceFolders: folders,
      lastEntryFile: this.anchoredEntry ?? this.lastGoodModel?.entryFile,
      lastGraphPaths: graph,
    });

    if (!anchor) {
      this.model = {
        roots: [],
        entryFile: '',
        truncated: false,
        unresolvedCount: 0,
        fileCount: 0,
        timingsMs: { total: 0 },
        emptyMessage:
          'No ConTeXt product or project found. Open a .tex / .mkiv file, set context.rootFile, or run ConTeXt: New Document Structure…',
      };
      this.applyOutsideMessage(false, undefined);
      return this.model;
    }

    const includeInputs = cfg.get<boolean>('projectView.includeInputs', false) ?? false;
    const maxFiles = cfg.get<number>('projectView.maxFiles', 500) ?? 500;

    let built = buildProjectModel({
      entryFile: anchor.entryFile,
      activeFile: active || undefined,
      workspaceFolders: folders,
      includeInputs,
      maxFiles,
    });

    // Never replace a strong tree with a lone-component stub.
    if (isWeakModel(built) && this.lastGoodModel && !isWeakModel(this.lastGoodModel)) {
      built = this.lastGoodModel;
      this.applyOutsideMessage(true, active);
    } else {
      this.applyOutsideMessage(anchor.outsideGraph, active);
      if (!isWeakModel(built)) {
        this.lastGoodModel = built;
        this.anchoredEntry = path.resolve(built.entryFile);
      } else if (!this.anchoredEntry) {
        this.anchoredEntry = path.resolve(anchor.entryFile);
      }
    }

    this.model = built;
    this.parentOf.clear();
    indexParents(this.model.roots, undefined, undefined, this.parentOf);

    const m = this.model;
    logDebug(
      `[projectView] entry=${m.entryFile} files=${m.fileCount} unresolved=${m.unresolvedCount}` +
        (m.truncated ? ' truncated=1' : '') +
        ` reason=${anchor.reason}` +
        (anchor.outsideGraph ? ' outside=1' : '') +
        ` ${m.timingsMs.total}ms`,
    );
    return this.model;
  }
}

function readQuiet(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function findNodeOccurrence(
  nodes: ProjectNode[],
  fsPath: string,
  parentId?: string,
): { node: ProjectNode; parentId?: string } | undefined {
  const abs = path.resolve(fsPath);
  for (const n of nodes) {
    if (n.fsPath && path.resolve(n.fsPath) === abs) {
      return { node: n, parentId };
    }
    const child = findNodeOccurrence(n.children, fsPath, treeId(n, parentId));
    if (child) {
      return child;
    }
  }
  return undefined;
}

function indexParents(
  nodes: ProjectNode[],
  parent: ProjectNode | undefined,
  parentId: string | undefined,
  map: Map<string, ParentRef>,
  /** Id prefix used when constructing `parent` as a TreeItem (grandparent id). */
  grandparentId?: string,
): void {
  for (const n of nodes) {
    const id = treeId(n, parentId);
    if (parent) {
      map.set(id, { parent, parentId: grandparentId });
    }
    indexParents(n.children, n, id, map, parentId);
  }
}

/** Register the Project view and its commands. Returns disposables. */
export function registerProjectView(
  context: vscode.ExtensionContext,
  deps: ProjectTreeProviderDeps & {
    buildNode: (node: ProjectNode) => void;
    forwardSyncNode: (node: ProjectNode) => void;
    setRootFromNode: (node: ProjectNode) => Promise<void>;
  },
): ProjectTreeProvider {
  const provider = new ProjectTreeProvider(deps);
  const view = vscode.window.createTreeView(PROJECT_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.setTreeView(view);

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('context.projectView.refresh', () => {
      provider.refresh();
    }),
    vscode.commands.registerCommand('context.projectView.revealActive', () => {
      void provider.revealActive();
    }),
    vscode.commands.registerCommand(
      'context.projectView.buildNode',
      (item?: ProjectTreeItem) => {
        if (item?.node) {
          deps.buildNode(item.node);
        }
      },
    ),
    vscode.commands.registerCommand(
      'context.projectView.forwardSyncNode',
      (item?: ProjectTreeItem) => {
        if (item?.node) {
          deps.forwardSyncNode(item.node);
        }
      },
    ),
    vscode.commands.registerCommand(
      'context.projectView.setRootFromNode',
      (item?: ProjectTreeItem) => {
        if (item?.node) {
          void deps.setRootFromNode(item.node);
        }
      },
    ),
    vscode.window.onDidChangeActiveTextEditor(() => {
      provider.onActiveEditorChanged();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\.(tex|mkiv|mkxl|mkvi|mklx|mkii|ctx)$/i.test(doc.uri.fsPath)) {
        provider.scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (/\.(tex|mkiv|mkxl|mkvi|mklx|mkii|ctx)$/i.test(e.document.uri.fsPath)) {
        provider.scheduleRefresh();
      }
    }),
    vscode.workspace.onDidCreateFiles(() => provider.scheduleRefresh()),
    vscode.workspace.onDidDeleteFiles(() => provider.scheduleRefresh()),
    vscode.workspace.onDidRenameFiles(() => provider.scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('context.rootFile') ||
        e.affectsConfiguration('context.projectView')
      ) {
        provider.refresh();
      }
    }),
  );

  return provider;
}
