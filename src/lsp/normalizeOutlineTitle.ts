/**
 * DigestiF DocumentSymbol names often keep TeX bracing and source newlines
 * (e.g. `{Enfermedad de\nGaucher}`). Normalize for Outline display only.
 */

export function normalizeOutlineTitle(raw: string): string {
  let s = raw.trim();
  // Strip one wrapping brace pair when the whole name is braced.
  if (s.length >= 2 && s.startsWith('{') && s.endsWith('}')) {
    s = s.slice(1, -1).trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Mutable name + optional children (DocumentSymbol or SymbolInformation). */
export interface OutlineSymbolLike {
  name: string;
  children?: OutlineSymbolLike[];
}

/**
 * Recursively rewrite `name` on DocumentSymbol trees (and flat SymbolInformation lists).
 * Mutates in place.
 */
export function normalizeOutlineSymbols(symbols: OutlineSymbolLike[]): void {
  for (const sym of symbols) {
    sym.name = normalizeOutlineTitle(sym.name);
    if (Array.isArray(sym.children)) {
      normalizeOutlineSymbols(sym.children);
    }
  }
}
