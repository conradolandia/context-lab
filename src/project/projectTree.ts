import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildProjectModel,
  type ProjectModelResult,
  type ProjectNode,
} from './projectModel';
import { resolveRootFile } from './rootFile';
import * as fs from 'node:fs';

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
  ) {
    super(node.label, collapsible);
    this.tooltip = buildTooltip(node);
    this.description = describeNode(node);
    this.contextValue = contextValueFor(node);
    this.iconPath = iconFor(node);
    this.id = treeId(node);

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

function treeId(node: ProjectNode): string {
  const base = node.fsPath ?? `missing:${node.kind}:${node.label}`;
  return `${node.kind}:${base}:${node.commandStart ?? 0}`;
}

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

export interface ProjectTreeProviderDeps {
  output: vscode.OutputChannel;
  workspaceFolderPaths: () => string[];
  activeTexPath: () => string | undefined;
  getRootFileSetting: () => string;
}

/**
 * TreeDataProvider for the ConTeXt Project view.
 */
export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ProjectTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private model: ProjectModelResult | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private treeView: vscode.TreeView<ProjectTreeItem> | undefined;
  /** path/id → parent node for reveal */
  private parentOf = new Map<string, ProjectNode>();

  constructor(private readonly deps: ProjectTreeProviderDeps) {}

  setTreeView(view: vscode.TreeView<ProjectTreeItem>): void {
    this.treeView = view;
  }

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
        // Show empty copy as a message node when only a lone document / message.
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
    return element.node.children.map((n) => new ProjectTreeItem(n, collapsibleState(n)));
  }

  getParent(element: ProjectTreeItem): ProjectTreeItem | undefined {
    const parent = this.parentOf.get(treeId(element.node));
    if (!parent) {
      return undefined;
    }
    return new ProjectTreeItem(parent, collapsibleState(parent));
  }

  async revealActive(): Promise<void> {
    const active = this.deps.activeTexPath();
    if (!active || !this.treeView) {
      return;
    }
    const result = this.ensureModel();
    const hit = findNodeByPath(result.roots, active);
    if (!hit) {
      return;
    }
    const item = new ProjectTreeItem(hit, collapsibleState(hit));
    try {
      await this.treeView.reveal(item, { select: true, focus: false, expand: 2 });
    } catch {
      // reveal can fail if the element is not currently known to the view
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

    if (!active && !this.deps.getRootFileSetting().trim() && folders.length === 0) {
      this.model = {
        roots: [],
        entryFile: '',
        truncated: false,
        unresolvedCount: 0,
        fileCount: 0,
        timingsMs: { total: 0 },
        emptyMessage:
          'No ConTeXt product or project found. Open a .tex / .mkiv file or set context.rootFile.',
      };
      return this.model;
    }

    let activeText = '';
    const activePath = active ?? '';
    if (activePath) {
      try {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === activePath);
        activeText = open ? open.getText() : fs.readFileSync(activePath, 'utf8');
      } catch {
        activeText = '';
      }
    }

    const entryPath =
      activePath ||
      (this.deps.getRootFileSetting().trim()
        ? resolveSettingPath(this.deps.getRootFileSetting(), folders)
        : undefined);

    if (!entryPath) {
      this.model = {
        roots: [],
        entryFile: '',
        truncated: false,
        unresolvedCount: 0,
        fileCount: 0,
        timingsMs: { total: 0 },
        emptyMessage:
          'No ConTeXt product or project found. Open a .tex / .mkiv file or set context.rootFile.',
      };
      return this.model;
    }

    const resolved = resolveRootFile({
      activeFile: entryPath,
      activeText: activeText || readQuiet(entryPath),
      rootFileSetting: this.deps.getRootFileSetting(),
      workspaceFolders: folders,
    });

    const includeInputs = cfg.get<boolean>('projectView.includeInputs', false) ?? false;
    const maxFiles = cfg.get<number>('projectView.maxFiles', 500) ?? 500;

    this.model = buildProjectModel({
      entryFile: resolved.rootFile,
      activeFile: activePath || undefined,
      workspaceFolders: folders,
      includeInputs,
      maxFiles,
    });

    this.parentOf.clear();
    indexParents(this.model.roots, undefined, this.parentOf);

    const m = this.model;
    this.deps.output.appendLine(
      `[projectView] entry=${m.entryFile} files=${m.fileCount} unresolved=${m.unresolvedCount}` +
        (m.truncated ? ' truncated=1' : '') +
        ` ${m.timingsMs.total}ms`,
    );
    return this.model;
  }
}

function resolveSettingPath(setting: string, folders: string[]): string | undefined {
  const s = setting.trim();
  if (!s) {
    return undefined;
  }
  if (path.isAbsolute(s)) {
    return s;
  }
  if (folders[0]) {
    return path.resolve(folders[0], s);
  }
  return path.resolve(s);
}

function readQuiet(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function findNodeByPath(nodes: ProjectNode[], fsPath: string): ProjectNode | undefined {
  const abs = path.resolve(fsPath);
  for (const n of nodes) {
    if (n.fsPath && path.resolve(n.fsPath) === abs) {
      return n;
    }
    const child = findNodeByPath(n.children, fsPath);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function indexParents(
  nodes: ProjectNode[],
  parent: ProjectNode | undefined,
  map: Map<string, ProjectNode>,
): void {
  for (const n of nodes) {
    if (parent) {
      map.set(treeId(n), parent);
    }
    indexParents(n.children, n, map);
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
      provider.scheduleRefresh();
      void provider.revealActive();
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
