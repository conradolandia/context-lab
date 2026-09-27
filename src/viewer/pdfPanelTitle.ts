import * as path from 'node:path';

/** Fallback webview tab title when no PDF path is known. */
export const DEFAULT_PDF_PANEL_TITLE = 'PDF';

/** Webview tab title: PDF basename only (never a full path). */
export function pdfPanelTitle(pdfPath: string | undefined): string {
  if (!pdfPath) {
    return DEFAULT_PDF_PANEL_TITLE;
  }
  const base = path.basename(pdfPath);
  return base || DEFAULT_PDF_PANEL_TITLE;
}
