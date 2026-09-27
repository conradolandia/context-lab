/** Marketplace / VSIX id for LaTeX Workshop (publisher.name). */
export const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

const DONT_ASK_STATE_KEY = 'context.latexWorkshopConflict.dontAsk';
const DONT_ASK_SETTING = 'context.latexWorkshopConflict.dontAsk';

export { DONT_ASK_STATE_KEY, DONT_ASK_SETTING };

/**
 * True when LaTeX Workshop's package.json contributes language id `context`
 * (and thus can steal the TextMate grammar for that id).
 */
export function latexWorkshopContributesContextLanguage(packageJSON: unknown): boolean {
  if (!packageJSON || typeof packageJSON !== 'object') {
    return false;
  }
  const contributes = (packageJSON as { contributes?: unknown }).contributes;
  if (!contributes || typeof contributes !== 'object') {
    return false;
  }
  const languages = (contributes as { languages?: unknown }).languages;
  if (!Array.isArray(languages)) {
    return false;
  }
  return languages.some(
    (lang) =>
      lang !== null &&
      typeof lang === 'object' &&
      (lang as { id?: unknown }).id === 'context',
  );
}

/**
 * Pure gate for the one-shot LaTeX Workshop conflict warning.
 * Skips Extension Development Host (F5): the under-development grammar
 * registers last and wins, so the conflict does not appear there.
 */
export function shouldWarnLatexWorkshopConflict(options: {
  dontAsk: boolean;
  alreadyShownThisSession: boolean;
  lwExtensionPresent: boolean;
  lwContributesContext: boolean;
  extensionModeDevelopment: boolean;
}): boolean {
  if (options.dontAsk) {
    return false;
  }
  if (options.alreadyShownThisSession) {
    return false;
  }
  if (options.extensionModeDevelopment) {
    return false;
  }
  if (!options.lwExtensionPresent) {
    return false;
  }
  if (!options.lwContributesContext) {
    return false;
  }
  return true;
}

/** Merge `James-Yu.latex-workshop` into an extensions.json-shaped object. */
export function mergeUnwantedLatexWorkshopRecommendation(
  existing: unknown,
): { recommendations?: string[]; unwantedRecommendations: string[] } {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const recommendations = Array.isArray(base.recommendations)
    ? [...(base.recommendations as unknown[]).filter((x): x is string => typeof x === 'string')]
    : undefined;
  const unwanted = Array.isArray(base.unwantedRecommendations)
    ? [
        ...(base.unwantedRecommendations as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        ),
      ]
    : [];
  if (!unwanted.includes(LATEX_WORKSHOP_EXT_ID)) {
    unwanted.push(LATEX_WORKSHOP_EXT_ID);
  }
  const out: { recommendations?: string[]; unwantedRecommendations: string[] } = {
    unwantedRecommendations: unwanted,
  };
  if (recommendations && recommendations.length > 0) {
    out.recommendations = recommendations;
  }
  // Preserve other top-level keys only if we are rewriting a fuller object elsewhere;
  // callers that need full merge should start from `base` + these fields.
  return out;
}

/**
 * Full merge for writing `.vscode/extensions.json`: keep unknown keys,
 * ensure unwantedRecommendations includes LaTeX Workshop.
 */
export function upsertExtensionsJsonUnwanted(
  existing: unknown,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const merged = mergeUnwantedLatexWorkshopRecommendation(base);
  base.unwantedRecommendations = merged.unwantedRecommendations;
  if (merged.recommendations) {
    base.recommendations = merged.recommendations;
  }
  return base;
}
