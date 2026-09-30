/** What started a ConTeXt build. */
export type BuildTrigger = 'command' | 'onSave' | 'queued';

/** Save builds (and their coalesced follow-ups) must not steal editor focus. */
export function preserveFocusForBuildTrigger(trigger: BuildTrigger): boolean {
  return trigger === 'onSave' || trigger === 'queued';
}
