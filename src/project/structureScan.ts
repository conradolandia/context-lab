import { findVerbatimRanges, isCommentLine, offsetInRanges, stripLineComment } from './verbatimRegions';
import { parseUsePathBody } from './pathResolve';

/** Load / structure commands that refer to another file. */
export type IncludeKind =
  | 'component'
  | 'product'
  | 'environment'
  | 'project'
  | 'input'
  | 'usemodule'
  | 'externalfigure';

export interface IncludeRef {
  kind: IncludeKind;
  /** Raw name as written (no braces/brackets). */
  name: string;
  /** Start offset of the name token in the document. */
  nameStart: number;
  /** End offset (exclusive) of the name token. */
  nameEnd: number;
  /** Start offset of the command (`\\component` etc.). */
  commandStart: number;
}

export interface StructureScanResult {
  usePaths: string[];
  includes: IncludeRef[];
}

const USEPATH = /\\usepath\s*\[([^\]]*)\]/g;

/**
 * Match:
 *   \component name
 *   \component[name]
 *   \component{name}
 * and the same for product / environment / project / input / usemodule / externalfigure.
 */
const INCLUDE_CMD =
  /\\(component|product|environment|project|input|usemodule|externalfigure)\b\s*(?:\[([^\]]*)\]|\{([^}]*)\}|([^\s\]\}%\\]+))?/g;

/**
 * Scan one ConTeXt source buffer for `\\usepath` and file-load commands.
 * Skips comment lines and bodies of common verbatim / Lua / MetaPost regions.
 */
export function scanStructure(text: string): StructureScanResult {
  const verbatim = findVerbatimRanges(text);
  const usePaths: string[] = [];
  const includes: IncludeRef[] = [];

  // Line map for comment checks
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  function lineIndexAt(offset: number): number {
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

  function lineTextAt(offset: number): string {
    const li = lineIndexAt(offset);
    const start = lineStarts[li];
    const end = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : text.length;
    return text.slice(start, end);
  }

  USEPATH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USEPATH.exec(text)) !== null) {
    if (offsetInRanges(m.index, verbatim)) {
      continue;
    }
    if (isCommentLine(lineTextAt(m.index))) {
      continue;
    }
    usePaths.push(...parseUsePathBody(m[1]));
  }

  INCLUDE_CMD.lastIndex = 0;
  while ((m = INCLUDE_CMD.exec(text)) !== null) {
    if (offsetInRanges(m.index, verbatim)) {
      continue;
    }
    const line = lineTextAt(m.index);
    if (isCommentLine(line)) {
      continue;
    }
    // Ignore if the match sits after a `%` on the same line
    const lineStart = lineStarts[lineIndexAt(m.index)];
    const prefix = text.slice(lineStart, m.index);
    if (stripLineComment(prefix).length !== prefix.length) {
      continue;
    }

    const kind = m[1] as IncludeKind;
    const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!raw) {
      continue;
    }
    // For bracket/brace forms, name may be comma-separated (usemodule); take first token for linking.
    const name = raw.split(',')[0]?.trim() ?? raw;
    if (!name) {
      continue;
    }

    // Locate name span inside the match
    const full = m[0];
    const nameOffsetInMatch = full.lastIndexOf(name);
    const nameStart =
      nameOffsetInMatch >= 0 ? m.index + nameOffsetInMatch : m.index + full.length - name.length;
    includes.push({
      kind,
      name,
      nameStart,
      nameEnd: nameStart + name.length,
      commandStart: m.index,
    });
  }

  return { usePaths, includes };
}
