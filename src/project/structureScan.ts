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

/** Role of *this* file from `\\startproject` / `\\startproduct` / … (English interface). */
export type StructureRole = 'project' | 'product' | 'component' | 'environment';

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

export interface FileRoleInfo {
  role: StructureRole;
  /** Optional name from `\\startproduct book` / `\\startcomponent[chap]`. */
  name?: string;
  commandStart: number;
}

export interface StructureScanResult {
  usePaths: string[];
  includes: IncludeRef[];
  /** First `\\start(project|product|component|environment)` in the file, if any. */
  fileRole?: FileRoleInfo;
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

/** `\\startproduct book`, `\\startcomponent[chap]`, `\\startenvironment{env}`, … */
const START_ROLE =
  /\\start(project|product|component|environment)\b\s*(?:\[([^\]]*)\]|\{([^}]*)\}|([^\s\]\}%\\]+))?/g;

/**
 * Scan one ConTeXt source buffer for `\\usepath`, file-load commands, and this
 * file’s structure role. Skips comment lines and bodies of common verbatim /
 * Lua / MetaPost regions. English interface command names only.
 */
export function scanStructure(text: string): StructureScanResult {
  const verbatim = findVerbatimRanges(text);
  const usePaths: string[] = [];
  const includes: IncludeRef[] = [];
  let fileRole: FileRoleInfo | undefined;

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

  function isSkipped(offset: number): boolean {
    if (offsetInRanges(offset, verbatim)) {
      return true;
    }
    const line = lineTextAt(offset);
    if (isCommentLine(line)) {
      return true;
    }
    const lineStart = lineStarts[lineIndexAt(offset)];
    const prefix = text.slice(lineStart, offset);
    return stripLineComment(prefix).length !== prefix.length;
  }

  USEPATH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USEPATH.exec(text)) !== null) {
    if (isSkipped(m.index)) {
      continue;
    }
    usePaths.push(...parseUsePathBody(m[1]));
  }

  START_ROLE.lastIndex = 0;
  while ((m = START_ROLE.exec(text)) !== null) {
    if (isSkipped(m.index)) {
      continue;
    }
    const role = m[1] as StructureRole;
    const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    const name = raw ? (raw.split(',')[0]?.trim() ?? raw) : undefined;
    fileRole = {
      role,
      name: name || undefined,
      commandStart: m.index,
    };
    break; // first role wins
  }

  INCLUDE_CMD.lastIndex = 0;
  while ((m = INCLUDE_CMD.exec(text)) !== null) {
    if (isSkipped(m.index)) {
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

  return { usePaths, includes, fileRole };
}
