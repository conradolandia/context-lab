/**
 * Parse ConTeXt LMTX console / `.log` text into file:line diagnostics.
 *
 * Patterns verified against LMTX fixtures generated on 2026-09-27:
 * - `tex error > tex error on line N in file PATH: MESSAGE`
 * - `error (input): file {NAME} is not found, quitting`
 * - `modules > 'NAME' is not found`
 * - `pack quality > overfull hbox at line N in file 'PATH': …`
 * - `pack quality > loose hbox at line N in file 'PATH': …` (LMTX underfull)
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface ParsedDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** Absolute or as-written path from the log (may be `./foo.tex`). */
  file?: string;
  /** 1-based line; undefined when the log has no line. */
  line?: number;
  source: string;
}

export interface ParseLogOptions {
  /** Working directory of the compile (used only by callers for path resolve). */
  cwd?: string;
}

const TEX_ERROR =
  /tex error\s*>\s*tex error on line\s+(\d+)\s+in file\s+(.+?):\s*(.*)$/i;

const INPUT_MISSING =
  /error\s*\(input\):\s*file\s*\{([^}]+)\}\s*is not found/i;

const MODULE_MISSING = /modules\s*>\s*'([^']+)'\s*is not found/i;

const PACK_QUALITY =
  /pack quality\s*>\s*(overfull|loose|underfull)\s+(h|v)box\s+at line\s+(\d+)\s+in file\s+'?([^']+?)'?\s*:\s*(.*)$/i;

/** Classic TeX wording (kept for older logs / MkIV). */
const CLASSIC_OVERFULL =
  /(Overfull|Underfull)\s+\\(h|v)box\b.*?(?:at lines?\s+(\d+)(?:--\d+)?|lines?\s+(\d+)(?:--\d+)?)/i;

function stripQuotes(p: string): string {
  return p.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Parse concatenated stdout + stderr + `.log` text.
 * Duplicate messages (multi-pass runs) are deduped by severity+file+line+message.
 */
export function parseContextLog(text: string, _options: ParseLogOptions = {}): ParsedDiagnostic[] {
  const out: ParsedDiagnostic[] = [];
  const seen = new Set<string>();

  const push = (d: ParsedDiagnostic) => {
    const key = `${d.severity}|${d.file ?? ''}|${d.line ?? ''}|${d.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(d);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\d+:/, ''); // tolerate `rg -n` clipped fixtures

    let m = TEX_ERROR.exec(line);
    if (m) {
      push({
        severity: 'error',
        line: Number(m[1]),
        file: stripQuotes(m[2]),
        message: m[3].trim() || 'TeX error',
        source: 'context.build',
      });
      continue;
    }

    m = INPUT_MISSING.exec(line);
    if (m) {
      push({
        severity: 'error',
        file: stripQuotes(m[1]),
        message: `file {${m[1]}} is not found`,
        source: 'context.build',
      });
      continue;
    }

    m = MODULE_MISSING.exec(line);
    if (m) {
      push({
        severity: 'error',
        message: `module '${m[1]}' is not found`,
        source: 'context.build',
      });
      continue;
    }

    m = PACK_QUALITY.exec(line);
    if (m) {
      const kind = m[1].toLowerCase();
      const box = `${m[2].toLowerCase()}box`;
      const detail = m[5].trim();
      const label =
        kind === 'overfull'
          ? `overfull ${box}`
          : kind === 'loose'
            ? `loose ${box} (underfull)`
            : `underfull ${box}`;
      push({
        severity: 'warning',
        line: Number(m[3]),
        file: stripQuotes(m[4]),
        message: detail ? `${label}: ${detail}` : label,
        source: 'context.build',
      });
      continue;
    }

    m = CLASSIC_OVERFULL.exec(line);
    if (m) {
      const lineNo = Number(m[3] || m[4]);
      push({
        severity: 'warning',
        line: Number.isFinite(lineNo) ? lineNo : undefined,
        message: line.trim(),
        source: 'context.build',
      });
    }
  }

  return out;
}

/** True when the parsed list has no error-severity items (warnings allowed). */
export function hasErrorDiagnostics(diags: ParsedDiagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}
