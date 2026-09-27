import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATEX_WORKSHOP_EXT_ID,
  latexWorkshopContributesContextLanguage,
  mergeUnwantedLatexWorkshopRecommendation,
  shouldWarnLatexWorkshopConflict,
  upsertExtensionsJsonUnwanted,
} from '../compat/latexWorkshopConflictPolicy';

describe('latexWorkshopContributesContextLanguage', () => {
  it('detects context language contribution', () => {
    assert.equal(
      latexWorkshopContributesContextLanguage({
        contributes: {
          languages: [{ id: 'latex' }, { id: 'context', extensions: ['.ctx'] }],
        },
      }),
      true,
    );
  });

  it('returns false when context is absent or package is empty', () => {
    assert.equal(
      latexWorkshopContributesContextLanguage({
        contributes: { languages: [{ id: 'latex' }] },
      }),
      false,
    );
    assert.equal(latexWorkshopContributesContextLanguage({}), false);
    assert.equal(latexWorkshopContributesContextLanguage(null), false);
    assert.equal(latexWorkshopContributesContextLanguage(undefined), false);
  });
});

describe('shouldWarnLatexWorkshopConflict', () => {
  const base = {
    dontAsk: false,
    alreadyShownThisSession: false,
    lwExtensionPresent: true,
    lwContributesContext: true,
    extensionModeDevelopment: false,
  };

  it('warns when LW is present and contributes context', () => {
    assert.equal(shouldWarnLatexWorkshopConflict(base), true);
  });

  it('skips dontAsk, session, F5, missing LW, or no context contrib', () => {
    assert.equal(shouldWarnLatexWorkshopConflict({ ...base, dontAsk: true }), false);
    assert.equal(
      shouldWarnLatexWorkshopConflict({ ...base, alreadyShownThisSession: true }),
      false,
    );
    assert.equal(
      shouldWarnLatexWorkshopConflict({ ...base, extensionModeDevelopment: true }),
      false,
    );
    assert.equal(
      shouldWarnLatexWorkshopConflict({ ...base, lwExtensionPresent: false }),
      false,
    );
    assert.equal(
      shouldWarnLatexWorkshopConflict({ ...base, lwContributesContext: false }),
      false,
    );
  });
});

describe('extensions.json unwantedRecommendations merge', () => {
  it('adds LaTeX Workshop id and preserves recommendations', () => {
    const merged = mergeUnwantedLatexWorkshopRecommendation({
      recommendations: ['other.ext'],
      unwantedRecommendations: ['already.there'],
    });
    assert.deepEqual(merged.recommendations, ['other.ext']);
    assert.deepEqual(merged.unwantedRecommendations, [
      'already.there',
      LATEX_WORKSHOP_EXT_ID,
    ]);
  });

  it('is idempotent for the LW id', () => {
    const once = upsertExtensionsJsonUnwanted({});
    const twice = upsertExtensionsJsonUnwanted(once);
    assert.deepEqual(twice.unwantedRecommendations, [LATEX_WORKSHOP_EXT_ID]);
    assert.equal(
      (twice.unwantedRecommendations as string[]).filter((x) => x === LATEX_WORKSHOP_EXT_ID)
        .length,
      1,
    );
  });

  it('preserves unrelated keys', () => {
    const out = upsertExtensionsJsonUnwanted({
      recommendations: ['a.b'],
      customNote: 1,
    });
    assert.equal(out.customNote, 1);
    assert.deepEqual(out.recommendations, ['a.b']);
    assert.deepEqual(out.unwantedRecommendations, [LATEX_WORKSHOP_EXT_ID]);
  });
});
