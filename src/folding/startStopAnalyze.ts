import {
  findVerbatimRanges,
  isCommentLine,
  offsetInRanges,
  stripLineComment,
} from '../project/verbatimRegions';

interface StartStopHit {
  kind: 'start' | 'stop';
  name: string;
  /** Line of the command (0-based). */
  line: number;
  offset: number;
  endOffset: number;
}

const START_STOP = /\\(start|stop)([A-Za-z]+)\b/g;

function collectHits(text: string): StartStopHit[] {
  const verbatim = findVerbatimRanges(text);
  const hits: StartStopHit[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  function lineAt(offset: number): number {
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
  function lineText(offset: number): string {
    const li = lineAt(offset);
    const start = lineStarts[li];
    const end = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : text.length;
    return text.slice(start, end);
  }

  START_STOP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = START_STOP.exec(text)) !== null) {
    if (offsetInRanges(m.index, verbatim)) {
      continue;
    }
    const lt = lineText(m.index);
    if (isCommentLine(lt)) {
      continue;
    }
    const lineStart = lineStarts[lineAt(m.index)];
    const prefix = text.slice(lineStart, m.index);
    if (stripLineComment(prefix).length !== prefix.length) {
      continue;
    }
    hits.push({
      kind: m[1] as 'start' | 'stop',
      name: m[2],
      line: lineAt(m.index),
      offset: m.index,
      endOffset: m.index + m[0].length,
    });
  }
  return hits;
}

export interface FoldAnalysis {
  ranges: { startLine: number; endLine: number }[];
  mismatches: {
    startName: string;
    stopName: string;
    startLine: number;
    stopLine: number;
    startOffset: number;
    stopOffset: number;
    startEndOffset: number;
    stopEndOffset: number;
  }[];
  unclosed: { name: string; line: number; offset: number; endOffset: number }[];
}

/**
 * Stack `\start<name>` / `\stop<name>`; record folding ranges and name mismatches.
 * Pure (no VS Code); skips common verbatim / Lua / MetaPost bodies.
 */
export function analyzeStartStop(text: string): FoldAnalysis {
  const hits = collectHits(text);
  const stack: StartStopHit[] = [];
  const ranges: FoldAnalysis['ranges'] = [];
  const mismatches: FoldAnalysis['mismatches'] = [];

  for (const hit of hits) {
    if (hit.kind === 'start') {
      stack.push(hit);
      continue;
    }
    if (stack.length === 0) {
      mismatches.push({
        startName: '(none)',
        stopName: hit.name,
        startLine: hit.line,
        stopLine: hit.line,
        startOffset: hit.offset,
        stopOffset: hit.offset,
        startEndOffset: hit.endOffset,
        stopEndOffset: hit.endOffset,
      });
      continue;
    }
    const opened = stack.pop()!;
    if (opened.name !== hit.name) {
      mismatches.push({
        startName: opened.name,
        stopName: hit.name,
        startLine: opened.line,
        stopLine: hit.line,
        startOffset: opened.offset,
        stopOffset: hit.offset,
        startEndOffset: opened.endOffset,
        stopEndOffset: hit.endOffset,
      });
    }
    if (hit.line > opened.line) {
      ranges.push({ startLine: opened.line, endLine: hit.line });
    }
  }

  const unclosed = stack.map((s) => ({
    name: s.name,
    line: s.line,
    offset: s.offset,
    endOffset: s.endOffset,
  }));

  return { ranges, mismatches, unclosed };
}
