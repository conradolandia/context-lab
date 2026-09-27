/** Soft cap for `\externalfigure` hover previews (CSS + width/height attrs). */
export const FIGURE_HOVER_MAX_WIDTH = 360;
export const FIGURE_HOVER_MAX_HEIGHT = 280;

export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Scale natural size into the hover box while keeping aspect ratio.
 * Returns integers suitable for HTML width/height attributes.
 */
export function constrainHoverImageSize(
  naturalWidth: number,
  naturalHeight: number,
  maxWidth = FIGURE_HOVER_MAX_WIDTH,
  maxHeight = FIGURE_HOVER_MAX_HEIGHT,
): { width: number; height: number } {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    return { width: maxWidth, height: Math.round((maxWidth * 3) / 4) };
  }
  const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}

/**
 * HTML img snippet for MarkdownString with supportHtml.
 * Prefer explicit width/height (from constrainHoverImageSize) so tall photos
 * cannot blow up the tooltip even if CSS max-* is stripped.
 */
export function figureHoverImgHtml(
  src: string,
  alt: string,
  size?: { width: number; height: number },
): string {
  const w = size?.width ?? FIGURE_HOVER_MAX_WIDTH;
  const h = size?.height;
  const heightAttr = h !== undefined ? ` height="${h}"` : '';
  return (
    `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(alt)}" ` +
    `width="${w}"${heightAttr} ` +
    `style="max-width:${FIGURE_HOVER_MAX_WIDTH}px;max-height:${FIGURE_HOVER_MAX_HEIGHT}px;` +
    `width:auto;height:auto;object-fit:contain;" />`
  );
}
