/**
 * JSON structure spec under `.context/structure.json`.
 * Spec-gated upgrade eligibility; create writes, upgrade updates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StructureTier } from './structureTiers';
import { TIER_LADDER } from './structureTiers';

export const STRUCTURE_SPEC_DIR = '.context';
export const STRUCTURE_SPEC_FILENAME = 'structure.json';
export const STRUCTURE_SPEC_REL = `${STRUCTURE_SPEC_DIR}/${STRUCTURE_SPEC_FILENAME}`;
export const STRUCTURE_SCHEMA_VERSION = 1;

export type StructureSpecCreatedBy =
  | 'context.projectManager.create'
  | 'context.projectManager.upgrade'
  | string;

export interface StructureSpec {
  schemaVersion: number;
  tier: StructureTier;
  /** Scaffold-relative path to the default/active compile product or document. */
  rootFile: string;
  environments?: string[];
  createdBy?: StructureSpecCreatedBy;
  createdAt?: string;
  updatedAt?: string;
}

export type StructureSpecValidation =
  | { ok: true; spec: StructureSpec }
  | { ok: false; reason: string };

function isTier(value: unknown): value is StructureTier {
  return (
    value === 'single' ||
    value === 'env-doc' ||
    value === 'product' ||
    value === 'project'
  );
}

/** Absolute path to `.context/structure.json` under a scaffold root. */
export function structureSpecPath(scaffoldRoot: string): string {
  return path.join(scaffoldRoot, STRUCTURE_SPEC_DIR, STRUCTURE_SPEC_FILENAME);
}

/** Scaffold-relative posix path for the compile root (never a `\startproject` file). */
export function relativeRootFile(
  scaffoldRoot: string,
  absoluteRootFile: string,
): string {
  return path.relative(scaffoldRoot, absoluteRootFile).split(path.sep).join('/');
}

export function buildStructureSpec(opts: {
  tier: StructureTier;
  /** Scaffold-relative compile root (product or document). */
  rootFile: string;
  environments?: string[];
  createdBy: StructureSpecCreatedBy;
  /** Preserve on upgrade when present. */
  createdAt?: string;
  now?: Date;
}): StructureSpec {
  const now = (opts.now ?? new Date()).toISOString();
  const rootFile = opts.rootFile.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rootFile) {
    throw new Error('structure spec rootFile is required');
  }
  const spec: StructureSpec = {
    schemaVersion: STRUCTURE_SCHEMA_VERSION,
    tier: opts.tier,
    rootFile,
    createdBy: opts.createdBy,
    createdAt: opts.createdAt ?? now,
    updatedAt: now,
  };
  if (opts.environments && opts.environments.length > 0) {
    spec.environments = [...opts.environments];
  }
  return spec;
}

export function serializeStructureSpec(spec: StructureSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

export function validateStructureSpec(raw: unknown): StructureSpecValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'Spec must be a JSON object.' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== STRUCTURE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Unsupported schemaVersion (expected ${STRUCTURE_SCHEMA_VERSION}).`,
    };
  }
  if (!isTier(obj.tier)) {
    return {
      ok: false,
      reason: 'tier must be single | env-doc | product | project.',
    };
  }
  if (typeof obj.rootFile !== 'string' || !obj.rootFile.trim()) {
    return { ok: false, reason: 'rootFile must be a non-empty relative path.' };
  }
  if (
    obj.environments !== undefined &&
    (!Array.isArray(obj.environments) ||
      obj.environments.some((e) => typeof e !== 'string'))
  ) {
    return { ok: false, reason: 'environments must be an array of strings when present.' };
  }
  const spec: StructureSpec = {
    schemaVersion: STRUCTURE_SCHEMA_VERSION,
    tier: obj.tier,
    rootFile: obj.rootFile.trim().replace(/\\/g, '/'),
  };
  if (obj.environments) {
    spec.environments = obj.environments as string[];
  }
  if (typeof obj.createdBy === 'string') {
    spec.createdBy = obj.createdBy;
  }
  if (typeof obj.createdAt === 'string') {
    spec.createdAt = obj.createdAt;
  }
  if (typeof obj.updatedAt === 'string') {
    spec.updatedAt = obj.updatedAt;
  }
  return { ok: true, spec };
}

export function parseStructureSpecText(text: string): StructureSpecValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'Spec is not valid JSON.' };
  }
  return validateStructureSpec(raw);
}

export function readStructureSpecFile(absPath: string): StructureSpecValidation {
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return { ok: false, reason: 'Structure spec file not found.' };
    }
    const text = fs.readFileSync(absPath, 'utf8');
    return parseStructureSpecText(text);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Walk from `startDir` upward (inclusive) looking for `.context/structure.json`.
 * Stops at filesystem root or when `stopAt` ancestors are exhausted.
 */
export function findStructureSpec(
  startDir: string,
  opts?: { stopAt?: string[]; maxLevels?: number },
): { scaffoldRoot: string; specPath: string; spec: StructureSpec } | undefined {
  const stop = new Set(
    (opts?.stopAt ?? []).map((p) => path.resolve(p)),
  );
  const maxLevels = opts?.maxLevels ?? 24;
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxLevels; i++) {
    const specPath = structureSpecPath(dir);
    const result = readStructureSpecFile(specPath);
    if (result.ok) {
      return { scaffoldRoot: dir, specPath, spec: result.spec };
    }
    if (stop.has(dir)) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/** Next rung on the wiki §1 ladder, or undefined at the top. */
export function nextStructureTier(tier: StructureTier): StructureTier | undefined {
  const idx = TIER_LADDER.indexOf(tier);
  if (idx < 0 || idx >= TIER_LADDER.length - 1) {
    return undefined;
  }
  return TIER_LADDER[idx + 1];
}

/** True when `to` is strictly above `from` on the ladder. */
export function isUpgradeEdge(from: StructureTier, to: StructureTier): boolean {
  return TIER_LADDER.indexOf(to) > TIER_LADDER.indexOf(from);
}
