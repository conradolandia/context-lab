/**
 * DigestiF start policy: never block build/SyncTeX; one failed attempt then stay off
 * until digestif settings change or the window reloads.
 */

export type DigestifStartPolicy = {
  /** context.digestif.enabled */
  enabled: boolean;
  /** True after one failed start (or missing DigestiF) this session. */
  failedOnce: boolean;
};

/** Build / preview / SyncTeX must never await DigestiF startup. */
export const BUILD_WAITS_ON_DIGESTIF = false;

export function shouldAttemptDigestifStart(policy: DigestifStartPolicy): boolean {
  return policy.enabled && !policy.failedOnce;
}

export function afterDigestifFailure(policy: DigestifStartPolicy): DigestifStartPolicy {
  return { ...policy, failedOnce: true };
}

/** Reset when context.digestif.enabled or context.digestifPath changes. */
export function afterDigestifSettingsChange(
  policy: DigestifStartPolicy,
  enabled: boolean,
): DigestifStartPolicy {
  return { enabled, failedOnce: false };
}
