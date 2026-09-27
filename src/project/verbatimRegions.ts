/**
 * Cheap verbatim / embedded-code region detection for scanners that should
 * ignore `\start…` / load commands inside typing, Lua, MetaPost, etc.
 */

/** Environment names whose bodies are treated as non-TeX for scanning. */
export const VERBATIM_ENV_NAMES = new Set(
  [
    'typing',
    'typingtyping',
    'TEX',
    'LUA',
    'MP',
    'XML',
    'PARSEDXML',
    'HTML',
    'CSS',
    'luacode',
    'luasetups',
    'lua',
    'ctxfunction',
    'ctxfunctiondefinition',
    'MPcode',
    'MPpage',
    'MPinclusions',
    'MPcalculation',
    'MPdefinitions',
    'MPextensions',
    'useMPgraphic',
    'reusableMPgraphic',
    'uniqueMPgraphic',
    'staticMPfigure',
    'tikzpicture',
    'buffer',
  ].map((s) => s.toLowerCase()),
);

export interface TextRange {
  /** Inclusive start offset in the document text. */
  start: number;
  /** Exclusive end offset in the document text. */
  end: number;
}

/**
 * Find bodies of known verbatim / Lua / MetaPost environments.
 * Nested same-name pairs are not fully handled; good enough for common docs.
 */
export function findVerbatimRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const stack: { name: string; bodyStart: number }[] = [];
  const re = /\\(start|stop)([A-Za-z]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const kind = m[1];
    const name = m[2];
    const lower = name.toLowerCase();
    if (kind === 'start') {
      if (VERBATIM_ENV_NAMES.has(lower)) {
        // Body starts after the start command (and optional args on the same line).
        const afterCmd = m.index + m[0].length;
        let bodyStart = afterCmd;
        const restOfLine = text.slice(afterCmd, text.indexOf('\n', afterCmd) === -1 ? text.length : text.indexOf('\n', afterCmd));
        // Skip optional [...] / {...} immediately after \startName on the same chunk.
        const argMatch = /^(\s*(?:\[[^\]]*\]|\{[^}]*\}))*/.exec(restOfLine);
        if (argMatch) {
          bodyStart = afterCmd + argMatch[0].length;
        }
        stack.push({ name: lower, bodyStart });
      }
      continue;
    }
    // stop
    if (!VERBATIM_ENV_NAMES.has(lower)) {
      continue;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === lower) {
        const opened = stack[i];
        ranges.push({ start: opened.bodyStart, end: m.index });
        stack.length = i;
        break;
      }
    }
  }
  // Unclosed: treat rest of file as verbatim body
  for (const opened of stack) {
    ranges.push({ start: opened.bodyStart, end: text.length });
  }
  return ranges;
}

export function offsetInRanges(offset: number, ranges: TextRange[]): boolean {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) {
      return true;
    }
  }
  return false;
}

/** True if the line is a TeX comment (leading optional whitespace + `%`, not `\%`). */
export function isCommentLine(line: string): boolean {
  return /^\s*%/.test(line);
}

/** Strip trailing `%…` comments from a line when `%` is not escaped. */
export function stripLineComment(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '%' && (i === 0 || line[i - 1] !== '\\')) {
      break;
    }
    out += ch;
  }
  return out;
}
