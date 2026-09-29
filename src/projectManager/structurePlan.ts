/**
 * Pure structure plan: wizard answers → file list + dry-run tree.
 * Templates follow wiki §1 / §4 / §5; layered environments §7.1.
 */

import * as path from 'node:path';
import type { StructureTier } from './structureTiers';

export type PlannedFileRole =
  | 'document'
  | 'environment'
  | 'product'
  | 'component'
  | 'project';

export interface PlannedFile {
  /** Absolute path. */
  path: string;
  /** Path relative to `scaffoldRoot` (posix-style for display). */
  relativePath: string;
  contents: string;
  role: PlannedFileRole;
}

export interface StructurePlanInput {
  tier: StructureTier;
  /** Parent directory under which the scaffold folder is created. */
  baseDir: string;
  /**
   * Scaffold folder / stem name (`book`, `series`, `mydoc`).
   * Files live under `path.join(baseDir, name)`.
   */
  name: string;
  /**
   * Ordered environment *stems* (no extension), wiki §7.1 load order.
   * Default: one `env_<name>` (or `env_<name>` with prefix scheme).
   */
  environments?: string[];
  /** Component stems for product / project (default chapter-01, chapter-02). */
  components?: string[];
  /** Product stems for project tier (default book-one, book-two). */
  products?: string[];
  /**
   * When true, use denser prefixes: `product_*`, `component_*`
   * (env_/project_ already match wiki §4/§5).
   */
  usePrefixedNames?: boolean;
  /** File extension including the dot. v1: `.tex` only. */
  extension?: string;
  /** Absolute paths that already exist (conflict detection). */
  existingPaths?: Iterable<string> | ((absPath: string) => boolean);
}

export interface StructurePlan {
  tier: StructureTier;
  /** Absolute directory that holds the scaffold. */
  scaffoldRoot: string;
  files: PlannedFile[];
  /** Absolute compile root (document or first/default product). */
  rootFile: string;
  /** Absolute paths that already exist. */
  conflicts: string[];
  /** Dry-run tree lines (relative). */
  treeLines: string[];
}

const DEFAULT_COMPONENTS = ['chapter-01', 'chapter-02'];
const DEFAULT_PRODUCTS = ['book-one', 'book-two'];

function existsChecker(
  existing: StructurePlanInput['existingPaths'],
): (abs: string) => boolean {
  if (!existing) {
    return () => false;
  }
  if (typeof existing === 'function') {
    return existing;
  }
  const set = new Set(
    [...existing].map((p) => path.resolve(p)),
  );
  return (abs) => set.has(path.resolve(abs));
}

function sanitizeStem(raw: string): string {
  const s = raw.trim().replace(/\\/g, '/').replace(/\.tex$/i, '');
  const base = s.split('/').filter(Boolean).pop() ?? s;
  return base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
}

function defaultEnvStem(name: string): string {
  return name.startsWith('env_') ? name : `env_${name}`;
}

function productFileStem(stem: string, prefixed: boolean): string {
  if (prefixed && !stem.startsWith('product_')) {
    return `product_${stem}`;
  }
  return stem;
}

function componentFileStem(stem: string, prefixed: boolean): string {
  if (prefixed && !stem.startsWith('component_')) {
    return `component_${stem}`;
  }
  return stem;
}

function projectFileStem(name: string): string {
  return name.startsWith('project_') ? name : `project_${name}`;
}

function chapterTitle(stem: string): string {
  const bare = stem.replace(/^(component_|chapter-)/, '').replace(/[-_]/g, ' ');
  return bare.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Chapter';
}

function envLoadLines(envStems: string[]): string {
  return envStems.map((e) => `\\environment ${e}`).join('\n');
}

function environmentContents(stem: string): string {
  return [
    `\\startenvironment ${stem}`,
    '',
    '% Shared setup (fonts, layout, headings, language, macros, …)',
    '',
    '\\stopenvironment',
    '',
  ].join('\n');
}

function singleDocumentContents(): string {
  return [
    '\\startdocument',
    '',
    '% Document body',
    '',
    '\\stopdocument',
    '',
  ].join('\n');
}

function envDocContents(envStems: string[]): string {
  return [
    envLoadLines(envStems),
    '',
    '\\startdocument',
    '',
    '% Document body',
    '',
    '\\stopdocument',
    '',
  ].join('\n');
}

function productContents(
  productStem: string,
  envStems: string[],
  componentStems: string[],
  opts?: { projectStem?: string },
): string {
  const lines = [`\\startproduct ${productStem}`, ''];
  if (opts?.projectStem) {
    lines.push(`\\project ${opts.projectStem}`, '');
  } else {
    lines.push(envLoadLines(envStems), '');
  }
  for (const c of componentStems) {
    lines.push(`\\component ${c}`);
  }
  lines.push('', '\\stopproduct', '');
  return lines.join('\n');
}

function componentContents(componentStem: string, envStems: string[]): string {
  const title = chapterTitle(componentStem);
  return [
    `\\startcomponent ${componentStem}`,
    '',
    envLoadLines(envStems),
    '',
    `\\startchapter[title={${title}}]`,
    '',
    '% Chapter body',
    '',
    '\\stopchapter',
    '',
    '\\stopcomponent',
    '',
  ].join('\n');
}

function projectContents(
  projectStem: string,
  envStems: string[],
  productStems: string[],
): string {
  const lines = [
    `\\startproject ${projectStem}`,
    '',
    envLoadLines(envStems),
    '',
  ];
  for (const p of productStems) {
    lines.push(`\\product ${p}`);
  }
  lines.push('', '\\stopproject', '');
  return lines.join('\n');
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function pushFile(
  files: PlannedFile[],
  scaffoldRoot: string,
  rel: string,
  contents: string,
  role: PlannedFileRole,
): void {
  const abs = path.resolve(scaffoldRoot, ...rel.split('/'));
  files.push({
    path: abs,
    relativePath: toPosix(rel),
    contents,
    role,
  });
}

function buildTreeLines(scaffoldName: string, files: PlannedFile[]): string[] {
  const lines = [`${scaffoldName}/`];
  const sorted = [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  for (const f of sorted) {
    const parts = f.relativePath.split('/');
    if (parts.length === 1) {
      lines.push(`|-- ${parts[0]}`);
    } else {
      // show nested as |-- dir/ then |   |-- file for first level only (wiki §5)
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

/**
 * Build a dry-run / apply plan for one wiki §1 tier.
 * Never writes to disk; never inserts `% !TEX root`.
 */
export function buildStructurePlan(input: StructurePlanInput): StructurePlan {
  const name = sanitizeStem(input.name);
  if (!name) {
    throw new Error('Structure name is required');
  }
  const ext = input.extension ?? '.tex';
  if (ext !== '.tex') {
    throw new Error('v1 scaffolds use .tex only');
  }
  const prefixed = input.usePrefixedNames === true;
  const scaffoldRoot = path.resolve(input.baseDir, name);
  const exists = existsChecker(input.existingPaths);

  const envStems =
    input.environments && input.environments.length > 0
      ? input.environments.map(sanitizeStem)
      : [defaultEnvStem(name)];

  const componentStems = (
    input.components && input.components.length > 0
      ? input.components
      : DEFAULT_COMPONENTS
  ).map(sanitizeStem);

  const productStems = (
    input.products && input.products.length > 0
      ? input.products
      : DEFAULT_PRODUCTS
  ).map(sanitizeStem);

  const files: PlannedFile[] = [];
  let rootFile = '';

  switch (input.tier) {
    case 'single': {
      const rel = `${name}${ext}`;
      pushFile(files, scaffoldRoot, rel, singleDocumentContents(), 'document');
      rootFile = files[0].path;
      break;
    }
    case 'env-doc': {
      for (const env of envStems) {
        pushFile(
          files,
          scaffoldRoot,
          `${env}${ext}`,
          environmentContents(env),
          'environment',
        );
      }
      const docRel = `${name}${ext}`;
      pushFile(files, scaffoldRoot, docRel, envDocContents(envStems), 'document');
      rootFile = path.join(scaffoldRoot, docRel);
      break;
    }
    case 'product': {
      for (const env of envStems) {
        pushFile(
          files,
          scaffoldRoot,
          `${env}${ext}`,
          environmentContents(env),
          'environment',
        );
      }
      const prodStem = productFileStem(name, prefixed);
      const prodRel = `${prodStem}${ext}`;
      const compFileStems = componentStems.map((c) => componentFileStem(c, prefixed));
      pushFile(
        files,
        scaffoldRoot,
        prodRel,
        productContents(prodStem, envStems, compFileStems),
        'product',
      );
      rootFile = path.join(scaffoldRoot, prodRel);
      for (let i = 0; i < componentStems.length; i++) {
        const fileStem = compFileStems[i];
        pushFile(
          files,
          scaffoldRoot,
          `${fileStem}${ext}`,
          componentContents(fileStem, envStems),
          'component',
        );
      }
      break;
    }
    case 'project': {
      for (const env of envStems) {
        pushFile(
          files,
          scaffoldRoot,
          `${env}${ext}`,
          environmentContents(env),
          'environment',
        );
      }
      const projStem = projectFileStem(name);
      pushFile(
        files,
        scaffoldRoot,
        `${projStem}${ext}`,
        projectContents(projStem, envStems, productStems.map((p) => productFileStem(p, prefixed))),
        'project',
      );
      const compFileStems = componentStems.map((c) => componentFileStem(c, prefixed));
      for (const p of productStems) {
        const prodStem = productFileStem(p, prefixed);
        const dir = p; // folder uses the logical product name
        pushFile(
          files,
          scaffoldRoot,
          `${dir}/${prodStem}${ext}`,
          productContents(prodStem, envStems, compFileStems, { projectStem: projStem }),
          'product',
        );
        for (const fileStem of compFileStems) {
          pushFile(
            files,
            scaffoldRoot,
            `${dir}/${fileStem}${ext}`,
            componentContents(fileStem, envStems),
            'component',
          );
        }
      }
      // Compile root: first product file
      const firstProd = files.find((f) => f.role === 'product');
      rootFile = firstProd?.path ?? files[0]?.path ?? '';
      break;
    }
    default: {
      const _exhaustive: never = input.tier;
      throw new Error(`Unknown tier: ${_exhaustive}`);
    }
  }

  // Safety: generated contents must not inject magic root comments
  for (const f of files) {
    if (/%\s*!TEX\s+root/i.test(f.contents)) {
      throw new Error(`Refusing plan that inserts % !TEX root (${f.relativePath})`);
    }
  }

  const conflicts = files
    .map((f) => f.path)
    .filter((p) => exists(p))
    .sort();

  return {
    tier: input.tier,
    scaffoldRoot,
    files,
    rootFile,
    conflicts,
    treeLines: buildTreeLines(name, files),
  };
}

/** Serialize a plan for the webview dry-run step. */
export function planToDryRunJson(plan: StructurePlan): {
  tier: StructureTier;
  scaffoldRoot: string;
  rootFile: string;
  conflicts: string[];
  treeLines: string[];
  files: { relativePath: string; role: PlannedFileRole }[];
} {
  return {
    tier: plan.tier,
    scaffoldRoot: plan.scaffoldRoot,
    rootFile: plan.rootFile,
    conflicts: plan.conflicts,
    treeLines: plan.treeLines,
    files: plan.files.map((f) => ({
      relativePath: f.relativePath,
      role: f.role,
    })),
  };
}
