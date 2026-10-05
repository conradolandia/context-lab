/**
 * Language ids treated as ConTeXt-like for editor features and DigestiF.
 * Includes `latex` so LW-associated `.tex` buffers still get links / save hooks
 * (DigestiF maps `tex`/`latex` → LaTeX tags; language id `context` → ConTeXt).
 */
export const CONTEXT_LIKE_LANGUAGE_IDS = ['context', 'tex', 'latex'] as const;

/** Disk extensions for ConTeXt/TeX sources (no leading dot). */
export const CONTEXT_SOURCE_EXTENSIONS = [
  'tex',
  'mkiv',
  'mkxl',
  'mkvi',
  'mklx',
  'mkii',
  'ctx',
] as const;

/** Glob for VS Code DocumentSelector `pattern` filters. */
export const CONTEXT_SOURCE_GLOB = `**/*.{${CONTEXT_SOURCE_EXTENSIONS.join(',')}}`;

/** Path suffix match for save/change refresh (Project tree, etc.). */
export const CONTEXT_SOURCE_PATH_REGEX = new RegExp(
  `\\.(${CONTEXT_SOURCE_EXTENSIONS.join('|')})$`,
  'i',
);

export type ContextLikeDocument = {
  languageId: string;
  uri: { fsPath: string };
};

export function isContextLikeLanguageId(languageId: string): boolean {
  return (CONTEXT_LIKE_LANGUAGE_IDS as readonly string[]).includes(languageId);
}

export function isContextSourcePath(fsPath: string): boolean {
  return CONTEXT_SOURCE_PATH_REGEX.test(fsPath);
}

/**
 * True when the document looks like ConTeXt/TeX by language id or file extension.
 * Used for save-build, fold diagnostics on change, and LW conflict prompts.
 */
export function isContextLikeDocument(doc: ContextLikeDocument): boolean {
  return isContextLikeLanguageId(doc.languageId) || isContextSourcePath(doc.uri.fsPath);
}

/**
 * Selector for folding, document links, and figure hover.
 * Languages include `latex` (same set as DigestiF / `isContextLikeDocument`).
 * Path pattern covers extension-based files regardless of language id.
 */
export const contextDocumentSelector = [
  { language: 'context' },
  { language: 'tex' },
  { language: 'latex' },
  { pattern: CONTEXT_SOURCE_GLOB },
];

/**
 * DigestiF document selector: language + scheme only (no path pattern).
 * DigestiF chooses ConTeXt vs LaTeX tags from language id; path-only matches
 * without a TeX language id would be the wrong mode.
 */
export const digestifDocumentSelector = (['file', 'untitled'] as const).flatMap((scheme) =>
  CONTEXT_LIKE_LANGUAGE_IDS.map((language) => ({ scheme, language })),
);
