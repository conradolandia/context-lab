/**
 * Wiki §1 simplest-structure ladder for the Project Manager wizard.
 * Source: project-and-file-management wiki §1 / §12 / §13.1.
 */

export type StructureTier = 'single' | 'env-doc' | 'product' | 'project';

/** Answers collected on the wizard “Need” step. */
export interface NeedAnswers {
  /** Setup is substantial and should be reused across files. */
  sharedSetup: boolean;
  /** One output is split into reusable parts (chapters / articles). */
  splitParts: boolean;
  /** Several related PDFs must be coordinated. */
  severalOutputs: boolean;
}

export interface TierRecommendation {
  tier: StructureTier;
  /** Human-readable reason tied to wiki §1. */
  reason: string;
  /**
   * Shown when the user forces `project` without several outputs,
   * or when answers push toward project (§13.1 early-project warning).
   */
  warning?: string;
}

export interface TierInfo {
  id: StructureTier;
  title: string;
  wikiSection: string;
  summary: string;
  compileHint: string;
}

export const TIER_INFO: Record<StructureTier, TierInfo> = {
  single: {
    id: 'single',
    title: 'Single document',
    wikiSection: '§1.1',
    summary: 'Everything in one file; no setup reuse yet.',
    compileHint: 'Compile that file.',
  },
  'env-doc': {
    id: 'env-doc',
    title: 'Document + environment',
    wikiSection: '§1.2',
    summary: 'Shared setup in an environment; content stays in the document.',
    compileHint: 'Compile the document file.',
  },
  product: {
    id: 'product',
    title: 'Product + components',
    wikiSection: '§1.3',
    summary: 'One output (book / thesis) split into reusable parts; no project file.',
    compileHint: 'Compile the product file (components may also compile alone).',
  },
  project: {
    id: 'project',
    title: 'Project tier (several products)',
    wikiSection: '§1.4',
    summary:
      'Several related products share setup and need a coordination project file.',
    compileHint:
      'Compile each product (active/default product is the compile root) — never the \\startproject coordination file.',
  },
};

/** Short UI label: prefer “structure” language over bare “project”. */
export function structureTierLabel(tier: StructureTier): string {
  return TIER_INFO[tier].title;
}

/** Ordered ladder from simplest to heaviest (wiki §1 mental map). */
export const TIER_LADDER: StructureTier[] = ['single', 'env-doc', 'product', 'project'];

/**
 * Map need answers to the lowest matching wiki §1 tier.
 * Does not invent a project when one product with chapters is enough (§13.1).
 */
export function recommendTier(answers: NeedAnswers): TierRecommendation {
  if (answers.severalOutputs) {
    return {
      tier: 'project',
      reason:
        'Several related outputs need coordination (§1.4). Use project tier only when products must share setup and listing.',
    };
  }
  if (answers.splitParts) {
    return {
      tier: 'product',
      reason:
        'One output split into reusable parts (§1.3). A product + components is enough; a project-tier coordination file is not required.',
      warning: answers.sharedSetup
        ? undefined
        : 'Shared setup is common with products; an environment file will still be included so components compile alone.',
    };
  }
  if (answers.sharedSetup) {
    return {
      tier: 'env-doc',
      reason: 'Setup should be reused while content stays in one document (§1.2).',
    };
  }
  return {
    tier: 'single',
    reason: 'Nothing special yet — keep a single document (§1.1).',
  };
}

/**
 * Warning when the user overrides the recommendation toward a heavier tier,
 * especially choosing `project` without multiple products (§13.1).
 */
export function tierOverrideWarning(
  recommended: StructureTier,
  chosen: StructureTier,
): string | undefined {
  if (chosen === recommended) {
    return undefined;
  }
  const recIdx = TIER_LADDER.indexOf(recommended);
  const choseIdx = TIER_LADDER.indexOf(chosen);
  if (choseIdx < recIdx) {
    return undefined;
  }
  if (chosen === 'project' && recommended !== 'project') {
    return (
      'Starting with a project tier too early (§13.1). Prefer the simplest structure that matches the job; ' +
      'use project tier only when several related products must be coordinated.'
    );
  }
  if (choseIdx > recIdx) {
    return (
      `Recommended ${TIER_INFO[recommended].title} (${TIER_INFO[recommended].wikiSection}); ` +
      `you chose ${TIER_INFO[chosen].title}. Heavier structures add files you may not need yet.`
    );
  }
  return undefined;
}

/** §12 rule-of-thumb lines for wizard help. */
export const ROLE_RULES: { use: string; when: string }[] = [
  { use: 'environment', when: 'setup should be reused' },
  { use: 'component', when: 'content is reusable or independently processable' },
  { use: 'product', when: 'several pieces form one document / output' },
  { use: 'project', when: 'several related products need coordination' },
];
