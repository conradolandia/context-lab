import type { ProjectNode } from './projectModel';

/**
 * Local (parent-agnostic) id fragment for a project node.
 * Same file under different parents shares this fragment; full {@link treeId}
 * prefixes with the parent occurrence id so TreeItem.id stays unique.
 */
export function localTreeId(node: ProjectNode): string {
  const base = node.fsPath ?? `missing:${node.kind}:${node.label}`;
  return `${node.kind}:${base}:${node.commandStart ?? 0}`;
}

/**
 * Unique TreeItem id for one occurrence of `node` under `parentId`.
 * Roots omit `parentId`. Children use `${parentId}>${localTreeId(node)}`.
 */
export function treeId(node: ProjectNode, parentId?: string): string {
  const local = localTreeId(node);
  return parentId ? `${parentId}>${local}` : local;
}

/**
 * Flatten occurrence ids depth-first, matching ProjectTreeProvider.getChildren
 * parent → child id nesting (without constructing vscode.TreeItem).
 */
export function collectTreeIds(nodes: ProjectNode[], parentId?: string): string[] {
  const ids: string[] = [];
  for (const n of nodes) {
    const id = treeId(n, parentId);
    ids.push(id);
    if (n.children.length) {
      ids.push(...collectTreeIds(n.children, id));
    }
  }
  return ids;
}
