import * as fs from 'node:fs';

export type GetOpenText = (absolutePath: string) => string | undefined;

export interface ReadTexSourceOptions {
  /**
   * Open-buffer lookup. Return the document text when an editor has the file
   * open; return `undefined` to fall through to disk. Injectable for tests.
   */
  getOpenText?: GetOpenText;
  /** Disk read override (tests). Default: utf8 `readFileSync`. */
  readFile?: (absolutePath: string) => string;
}

/** Build a `getOpenText` from a document list (`vscode.workspace.textDocuments` or fakes). */
export function openTextFromDocuments(
  documents: readonly { uri: { fsPath: string }; getText(): string }[],
): GetOpenText {
  return (absolutePath) =>
    documents.find((d) => d.uri.fsPath === absolutePath)?.getText();
}

/**
 * Prefer an open editor buffer for `absPath`; otherwise read from disk.
 * Returns `''` when neither source is available.
 */
export function readTexSource(absPath: string, opts?: ReadTexSourceOptions): string {
  try {
    const open = opts?.getOpenText?.(absPath);
    if (open !== undefined) {
      return open;
    }
    const read = opts?.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
    return read(absPath);
  } catch {
    return '';
  }
}
