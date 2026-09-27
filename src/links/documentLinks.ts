import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  FIGURE_EXTENSIONS,
  parentSearchDirs,
  resolveIncludePath,
  TEX_INCLUDE_EXTENSIONS,
} from '../project/pathResolve';
import { scanStructure, type IncludeKind } from '../project/structureScan';
import {
  constrainHoverImageSize,
  figureHoverImgHtml,
} from './figureHoverMarkdown';
import { readImageSize } from './imageSize';

function isContextDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'context' || doc.languageId === 'tex' || doc.languageId === 'latex';
}

function extensionsFor(kind: IncludeKind): readonly string[] {
  if (kind === 'externalfigure') {
    return FIGURE_EXTENSIONS;
  }
  if (kind === 'usemodule') {
    return ['.mkiv', '.mkxl', '.mkvi', '.mklx', '.tex', '.lua', '.cld'];
  }
  return TEX_INCLUDE_EXTENSIONS;
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/**
 * Document links for `\component`, `\product`, `\environment`, `\project`,
 * `\input`, `\usemodule`, `\externalfigure`, respecting `\usepath`.
 */
export class ContextDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.DocumentLink[] {
    if (!isContextDoc(document)) {
      return [];
    }
    const text = document.getText();
    const { usePaths, includes } = scanStructure(text);
    const searchDirs = [
      ...parentSearchDirs(document.uri.fsPath, 3),
      ...workspaceFolders(),
    ];
    const links: vscode.DocumentLink[] = [];
    for (const inc of includes) {
      const resolved = resolveIncludePath({
        fromFile: document.uri.fsPath,
        name: inc.name,
        usePaths,
        searchDirs,
        extensions: extensionsFor(inc.kind),
      });
      if (!resolved) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(inc.nameStart),
        document.positionAt(inc.nameEnd),
      );
      const link = new vscode.DocumentLink(range, vscode.Uri.file(resolved));
      link.tooltip = path.basename(resolved);
      links.push(link);
    }
    return links;
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

/**
 * Hover preview for cheap image files referenced by `\externalfigure`.
 */
export class ContextFigureHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.Hover | undefined {
    if (!isContextDoc(document)) {
      return undefined;
    }
    const text = document.getText();
    const { usePaths, includes } = scanStructure(text);
    const offset = document.offsetAt(position);
    const hit = includes.find(
      (inc) =>
        inc.kind === 'externalfigure' && offset >= inc.nameStart && offset <= inc.nameEnd,
    );
    if (!hit) {
      return undefined;
    }
    const resolved = resolveIncludePath({
      fromFile: document.uri.fsPath,
      name: hit.name,
      usePaths,
      searchDirs: [...parentSearchDirs(document.uri.fsPath, 3), ...workspaceFolders()],
      extensions: FIGURE_EXTENSIONS,
    });
    if (!resolved || !IMAGE_EXT.test(resolved)) {
      return undefined;
    }
    const uri = vscode.Uri.file(resolved);
    const natural = readImageSize(resolved);
    const size = natural
      ? constrainHoverImageSize(natural.width, natural.height)
      : undefined;
    const md = new vscode.MarkdownString(
      figureHoverImgHtml(uri.toString(), path.basename(resolved), size),
    );
    md.isTrusted = true;
    md.supportHtml = true;
    return new vscode.Hover(
      md,
      new vscode.Range(document.positionAt(hit.nameStart), document.positionAt(hit.nameEnd)),
    );
  }
}
