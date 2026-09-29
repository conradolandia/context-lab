/**
 * Spec-gated structure upgrade deltas along the wiki §1 ladder.
 * Eligibility requires a valid `.context/structure.json` — never scan-guessed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StructureTier } from './structureTiers';
import { TIER_INFO, TIER_LADDER } from './structureTiers';
import {
  type PlannedFile,
  type StructurePlan,
  componentContents,
  componentFileStem,
  defaultEnvStem,
  ensureProjectDirective,
  envDocContents,
  environmentContents,
  extractDocumentBody,
  productContents,
  productFileStem,
  projectContents,
  projectFileStem,
  pushFile,
  sanitizeStem,
} from './structurePlan';
import {
  STRUCTURE_SPEC_REL,
  buildStructureSpec,
  isUpgradeEdge,
  nextStructureTier,
  relativeRootFile,
  serializeStructureSpec,
  type StructureSpec,
} from './structureSpec';

const DEFAULT_COMPONENTS = ['chapter-01', 'chapter-02'];

export interface UpgradePlanInput {
  scaffoldRoot: string;
  spec: StructureSpec;
  /** Target tier (must be above current). Default: next rung. */
  toTier?: StructureTier;
  /** Extra product stems when upgrading to project tier. */
  additionalProducts?: string[];
  /** Component stems when upgrading to product (default chapter-01, chapter-02). */
  components?: string[];
  /** Override environments; default from spec or env_<scaffoldName>. */
  environments?: string[];
  usePrefixedNames?: boolean;
  now?: Date;
  /** Optional filesystem reader (tests). */
  readFile?: (absPath: string) => string;
  exists?: (absPath: string) => boolean;
}

function readText(
  abs: string,
  readFile?: (absPath: string) => string,
): string {
  if (readFile) {
    return readFile(abs);
  }
  return fs.readFileSync(abs, 'utf8');
}

function pathExists(abs: string, exists?: (absPath: string) => boolean): boolean {
  if (exists) {
    return exists(abs);
  }
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

function scaffoldName(scaffoldRoot: string): string {
  return path.basename(scaffoldRoot) || 'document';
}

function resolveEnvStems(
  spec: StructureSpec,
  scaffoldRoot: string,
  override?: string[],
): string[] {
  if (override && override.length > 0) {
    return override.map(sanitizeStem);
  }
  if (spec.environments && spec.environments.length > 0) {
    return spec.environments.map(sanitizeStem);
  }
  return [defaultEnvStem(scaffoldName(scaffoldRoot))];
}

function listComponentStemsFromProduct(tex: string): string[] {
  const stems: string[] = [];
  const re = /\\component\s+\{?([^\s\}%]+)\}?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex)) !== null) {
    stems.push(sanitizeStem(m[1]));
  }
  return stems;
}

function buildTreeLines(scaffoldRoot: string, files: PlannedFile[]): string[] {
  const name = scaffoldName(scaffoldRoot);
  const lines = [`${name}/`];
  const sorted = [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  for (const f of sorted) {
    const parts = f.relativePath.split('/');
    if (parts.length === 1) {
      lines.push(`|-- ${parts[0]}`);
    } else {
      const dir = parts[0];
      const rest = parts.slice(1).join('/');
      const dirLine = `|-- ${dir}/`;
      if (!lines.includes(dirLine)) {
        lines.push(dirLine);
      }
      lines.push(`|   |-- ${rest}`);
    }
  }
  return lines;
}

function pushSpec(
  files: PlannedFile[],
  scaffoldRoot: string,
  tier: StructureTier,
  rootFileAbs: string,
  environments: string[],
  previous: StructureSpec,
  now?: Date,
): void {
  const spec = buildStructureSpec({
    tier,
    rootFile: relativeRootFile(scaffoldRoot, rootFileAbs),
    environments: tier === 'single' ? undefined : environments,
    createdBy: 'context.projectManager.upgrade',
    createdAt: previous.createdAt,
    now,
  });
  pushFile(
    files,
    scaffoldRoot,
    STRUCTURE_SPEC_REL,
    serializeStructureSpec(spec),
    'spec',
  );
}

/**
 * Build an in-place upgrade plan. Throws if the edge is invalid or sources missing.
 */
export function buildUpgradePlan(input: UpgradePlanInput): StructurePlan {
  const from = input.spec.tier;
  const to = input.toTier ?? nextStructureTier(from);
  if (!to) {
    throw new Error(
      `Structure is already at project tier (${TIER_INFO.project.title}); nothing to upgrade along §1.`,
    );
  }
  if (!isUpgradeEdge(from, to)) {
    throw new Error(
      `Cannot upgrade from ${from} to ${to}; target must be higher on the §1 ladder.`,
    );
  }
  // One step at a time for v1 deltas (multi-step: apply sequentially)
  const fromIdx = TIER_LADDER.indexOf(from);
  const toIdx = TIER_LADDER.indexOf(to);
  if (toIdx !== fromIdx + 1) {
    throw new Error(
      `v1 upgrades one rung at a time (next is ${TIER_LADDER[fromIdx + 1]}, not ${to}).`,
    );
  }

  const scaffoldRoot = path.resolve(input.scaffoldRoot);
  const ext = '.tex';
  const prefixed = input.usePrefixedNames === true;
  const envStems = resolveEnvStems(input.spec, scaffoldRoot, input.environments);
  const rootAbs = path.resolve(scaffoldRoot, input.spec.rootFile);
  if (!pathExists(rootAbs, input.exists)) {
    throw new Error(`Spec rootFile missing on disk: ${input.spec.rootFile}`);
  }

  const files: PlannedFile[] = [];
  const deletePaths: string[] = [];
  let rootFile = rootAbs;

  if (from === 'single' && to === 'env-doc') {
    const docText = readText(rootAbs, input.readFile);
    const body = extractDocumentBody(docText);
    for (const env of envStems) {
      pushFile(
        files,
        scaffoldRoot,
        `${env}${ext}`,
        environmentContents(env),
        'environment',
      );
    }
    pushFile(
      files,
      scaffoldRoot,
      input.spec.rootFile,
      envDocContents(envStems, body),
      'document',
    );
    rootFile = rootAbs;
  } else if (from === 'env-doc' && to === 'product') {
    const docText = readText(rootAbs, input.readFile);
    const body = extractDocumentBody(docText);
    const name = scaffoldName(scaffoldRoot);
    const prodStem = productFileStem(name, prefixed);
    const componentStems = (
      input.components && input.components.length > 0
        ? input.components
        : DEFAULT_COMPONENTS
    ).map(sanitizeStem);
    const compFileStems = componentStems.map((c) =>
      componentFileStem(c, prefixed),
    );

    for (const env of envStems) {
      const envRel = `${env}${ext}`;
      const envAbs = path.join(scaffoldRoot, envRel);
      if (!pathExists(envAbs, input.exists)) {
        pushFile(
          files,
          scaffoldRoot,
          envRel,
          environmentContents(env),
          'environment',
        );
      }
    }

    pushFile(
      files,
      scaffoldRoot,
      `${prodStem}${ext}`,
      productContents(prodStem, envStems, compFileStems),
      'product',
    );
    rootFile = path.join(scaffoldRoot, `${prodStem}${ext}`);

    for (let i = 0; i < compFileStems.length; i++) {
      const fileStem = compFileStems[i];
      const chapBody = i === 0 ? body : '% Chapter body';
      pushFile(
        files,
        scaffoldRoot,
        `${fileStem}${ext}`,
        componentContents(fileStem, envStems, chapBody),
        'component',
      );
    }

    // Remove former document if it is not the new product path
    if (path.resolve(rootAbs) !== path.resolve(rootFile)) {
      deletePaths.push(rootAbs);
    }
  } else if (from === 'product' && to === 'project') {
    const productText = readText(rootAbs, input.readFile);
    const name = scaffoldName(scaffoldRoot);
    const projStem = projectFileStem(name);
    const existingProdStem = sanitizeStem(
      path.basename(input.spec.rootFile, ext),
    );
    const extra = (
      input.additionalProducts && input.additionalProducts.length > 0
        ? input.additionalProducts
        : ['book-two']
    )
      .map(sanitizeStem)
      .filter((p) => p !== existingProdStem);

    const productList = [existingProdStem, ...extra];
    const componentStems = (() => {
      const fromProduct = listComponentStemsFromProduct(productText);
      if (fromProduct.length > 0) {
        return fromProduct;
      }
      return (
        input.components && input.components.length > 0
          ? input.components
          : DEFAULT_COMPONENTS
      ).map(sanitizeStem);
    })();

    pushFile(
      files,
      scaffoldRoot,
      `${projStem}${ext}`,
      projectContents(projStem, envStems, productList),
      'project',
    );

    const updatedProduct = ensureProjectDirective(productText, projStem);
    // Drop direct env loads when project will supply them via coordination —
    // keep file compilable: product with \\project still works; leave envs if present.
    pushFile(
      files,
      scaffoldRoot,
      input.spec.rootFile,
      updatedProduct,
      'product',
    );
    rootFile = rootAbs;

    for (const p of extra) {
      const prodStem = productFileStem(p, prefixed);
      const dir = p;
      pushFile(
        files,
        scaffoldRoot,
        `${dir}/${prodStem}${ext}`,
        productContents(prodStem, envStems, componentStems, {
          projectStem: projStem,
        }),
        'product',
      );
      for (const c of componentStems) {
        const fileStem = componentFileStem(c, prefixed);
        pushFile(
          files,
          scaffoldRoot,
          `${dir}/${fileStem}${ext}`,
          componentContents(fileStem, envStems),
          'component',
        );
      }
    }
  } else {
    throw new Error(`Unsupported upgrade edge ${from} → ${to}`);
  }

  pushSpec(
    files,
    scaffoldRoot,
    to,
    rootFile,
    envStems,
    input.spec,
    input.now,
  );

  for (const f of files) {
    if (f.role !== 'spec' && /%\s*!TEX\s+root/i.test(f.contents)) {
      throw new Error(`Refusing upgrade that inserts % !TEX root (${f.relativePath})`);
    }
  }

  const deleteSet = new Set(deletePaths.map((p) => path.resolve(p)));
  const conflicts = files
    .map((f) => f.path)
    .filter((p) => pathExists(p, input.exists) && !deleteSet.has(path.resolve(p)))
    // Spec overwrite and in-place document/product edits are expected
    .filter((p) => {
      const rel = relativeRootFile(scaffoldRoot, p);
      if (rel === STRUCTURE_SPEC_REL) {
        return false;
      }
      if (rel === input.spec.rootFile) {
        return false;
      }
      return true;
    })
    .sort();

  return {
    tier: to,
    scaffoldRoot,
    files,
    rootFile,
    conflicts,
    treeLines: buildTreeLines(scaffoldRoot, files),
    deletePaths: deletePaths.length > 0 ? deletePaths : undefined,
  };
}

export function upgradeRefusalMessage(): string {
  return (
    'This folder has no ConTeXt structure spec (`.context/structure.json`). ' +
    'Upgrade only works on scaffolds created by ConTeXt: New Document Structure…. ' +
    'Create a structure first, or add a valid spec manually.'
  );
}
