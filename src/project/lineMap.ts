/**
 * Build an array of start offsets for each line in `text` (0-based lines).
 * Index 0 is always 0; each entry after a newline is the offset of the next line.
 */
export function buildLineStarts(text: string): number[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

/**
 * Binary search: 0-based line index containing `offset`.
 * `lineStarts` must come from {@link buildLineStarts}.
 */
export function lineAtOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Line text containing `offset` (without trailing newline).
 * `lineStarts` must come from {@link buildLineStarts} on the same `text`.
 */
export function lineTextAtOffset(
  text: string,
  lineStarts: number[],
  offset: number,
): string {
  const li = lineAtOffset(lineStarts, offset);
  const start = lineStarts[li];
  const end = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : text.length;
  return text.slice(start, end);
}
