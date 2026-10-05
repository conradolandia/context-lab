/**
 * ConTeXt build modes: normalize catalog/active lists, strip conflicting
 * `--mode` tokens from `context.build.args`, and assemble final extra args.
 */

/** Warning when activeModes overrides `--mode` already present in build.args. */
export const MODE_OVERRIDE_WARNING =
  'context.build.activeModes overrides --mode in context.build.args; discarding the args --mode token(s).';

/**
 * Trim, drop empties, preserve first-seen order (dedupe case-sensitive).
 */
export function normalizeModes(modes: readonly string[] | undefined | null): string[] {
  if (!modes?.length) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of modes) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** `--mode=a,b` form used by the ConTeXt CLI. */
export function formatModeFlag(modes: readonly string[]): string {
  return `--mode=${normalizeModes(modes).join(',')}`;
}

export interface StripModeArgsResult {
  /** Args with `--mode` / `--mode=*` (and bare `--mode` + following token) removed. */
  cleaned: string[];
  /** True if any `--mode` token was present. */
  hadMode: boolean;
}

/**
 * Remove `--mode` / `--mode=value` and bare `--mode` + following token from an args list.
 * Other tokens are preserved in order.
 */
export function stripModeArgs(args: readonly string[]): StripModeArgsResult {
  const cleaned: string[] = [];
  let hadMode = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === '--mode') {
      hadMode = true;
      // Consume following token when it is not another flag.
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        i++;
      }
      continue;
    }
    if (tok.startsWith('--mode=')) {
      hadMode = true;
      continue;
    }
    cleaned.push(tok);
  }
  return { cleaned, hadMode };
}

export interface AssembleExtraArgsResult {
  /** Final extra args after `--synctex=repeat` (before the source path). */
  args: string[];
  /** Set when activeModes forced stripping of `--mode` from build.args. */
  warning?: string;
}

/**
 * Merge `context.build.args` with `context.build.activeModes`.
 *
 * - Non-empty activeModes → emit `--mode=a,b`; strip any `--mode*` from args and warn.
 * - Empty activeModes → leave args unchanged (including a manual `--mode`).
 */
export function assembleExtraArgs(
  settingArgs: readonly string[] | undefined | null,
  activeModes: readonly string[] | undefined | null,
): AssembleExtraArgsResult {
  const base = Array.isArray(settingArgs) ? [...settingArgs] : [];
  const modes = normalizeModes(activeModes);
  if (modes.length === 0) {
    return { args: base };
  }
  const { cleaned, hadMode } = stripModeArgs(base);
  const args = [...cleaned, formatModeFlag(modes)];
  if (hadMode) {
    return { args, warning: MODE_OVERRIDE_WARNING };
  }
  return { args };
}

/**
 * Append a mode name to a catalog if missing (after normalize). Returns the new catalog.
 */
export function appendModeToCatalog(
  catalog: readonly string[] | undefined | null,
  name: string,
): string[] {
  const next = normalizeModes(catalog);
  const trimmed = name.trim();
  if (!trimmed) {
    return next;
  }
  if (!next.includes(trimmed)) {
    next.push(trimmed);
  }
  return next;
}

/** Status-bar label for the current active modes. */
export function formatModesStatusText(activeModes: readonly string[]): string {
  const modes = normalizeModes(activeModes);
  if (modes.length === 0) {
    return 'Modes: (none)';
  }
  return `Modes: ${modes.join(', ')}`;
}
