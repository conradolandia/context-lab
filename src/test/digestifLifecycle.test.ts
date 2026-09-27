import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_WAITS_ON_DIGESTIF,
  afterDigestifFailure,
  afterDigestifSettingsChange,
  shouldAttemptDigestifStart,
} from '../lsp/digestifLifecycle';

describe('DigestiF must not block build', () => {
  it('BUILD_WAITS_ON_DIGESTIF is false (build never awaits DigestiF)', () => {
    assert.equal(BUILD_WAITS_ON_DIGESTIF, false);
  });

  it('after one failure, further starts are skipped until settings change', () => {
    let policy = { enabled: true, failedOnce: false };
    assert.equal(shouldAttemptDigestifStart(policy), true);

    policy = afterDigestifFailure(policy);
    assert.equal(policy.failedOnce, true);
    assert.equal(shouldAttemptDigestifStart(policy), false);

    // Retries must not happen on "every build" — only settings / reload.
    assert.equal(shouldAttemptDigestifStart(policy), false);

    policy = afterDigestifSettingsChange(policy, true);
    assert.equal(policy.failedOnce, false);
    assert.equal(shouldAttemptDigestifStart(policy), true);
  });

  it('disabled setting skips start even before failure', () => {
    assert.equal(shouldAttemptDigestifStart({ enabled: false, failedOnce: false }), false);
  });
});
