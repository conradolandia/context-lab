/**
 * Pure structure plan: wizard answers → file list + dry-run tree.
 * Templates follow wiki §1 / §4 / §5; layered environments §7.1.
 * Directory layout: `flat` (default) or `by-role` (role folders + \\usepath).
 * Every plan includes `.context/structure.json` (compile root = product/document).
 */

import * as path from 'node:path';
import type { StructureTier } from './structureTiers';
import {
  STRUCTURE_SPEC_REL,
  buildStructureSpec,
  relativeRootFile,
  resolveDirectoryLayout,
  serializeStructureSpec,
  type DirectoryLayout,
  type StructureSpecCreatedBy,
} from './structureSpec';

export type { DirectoryLayout };

export type PlannedFileRole =
  | 'document'
  | 'environment'
  | 'product'
  | 'component'
  | 'project'
  | 'spec';

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
  /**
   * Directory layout. Hidden / no-op for tier `single`.
   * Default `flat`. `by-role` uses role folders + `\\usepath`.
   */
  layout?: DirectoryLayout;
  /** File extension including the dot. v1: `.tex` only. */
  extension?: string;
  /** Absolute paths that already exist (conflict detection). */
  existingPaths?: Iterable<string> | ((absPath: string) => boolean);
  /** Who writes the structure spec (default: create). */
  createdBy?: StructureSpecCreatedBy;
  /** Optional clock for deterministic tests. */
  now?: Date;
}

export interface StructurePlan {
  tier: StructureTier;
  /** Absolute directory that holds the scaffold. */
  scaffoldRoot: string;
  files: PlannedFile[];
  /** Absolute compile root (document or first/default product — never \\startproject). */
  rootFile: string;
  /** Absolute paths that already exist. */
  conflicts: string[];
  /** Dry-run tree lines (relative). */
  treeLines: string[];
  /** Resolved directory layout used for this plan. */
  layout: DirectoryLayout;
  /** Absolute paths to delete when applying an upgrade (optional). */
  deletePaths?: string[];
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

export function sanitizeStem(raw: string): string {
  const s = raw.trim().replace(/\\/g, '/').replace(/\.tex$/i, '');
  const base = s.split('/').filter(Boolean).pop() ?? s;
  return base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
}

export function defaultEnvStem(name: string): string {
  return name.startsWith('env_') ? name : `env_${name}`;
}

export function productFileStem(stem: string, prefixed: boolean): string {
  if (prefixed && !stem.startsWith('product_')) {
    return `product_${stem}`;
  }
  return stem;
}

export function componentFileStem(stem: string, prefixed: boolean): string {
  if (prefixed && !stem.startsWith('component_')) {
    return `component_${stem}`;
  }
  return stem;
}

export function projectFileStem(name: string): string {
  return name.startsWith('project_') ? name : `project_${name}`;
}

/** Emit `\\usepath[a,b]` (no braces — matches pathResolve parsing). */
export function usePathDirective(dirs: string[]): string {
  return `\\usepath[${dirs.join(',')}]`;
}

/**
 * Insert or replace `\\usepath[...]` so ConTeXt / TreeView resolve role folders
 * when the compile cwd is the root file's directory.
 */
export function withUsePath(contents: string, dirs: string[]): string {
  if (dirs.length === 0) {
    return contents;
  }
  const line = usePathDirective(dirs);
  if (/\\usepath\s*\[[^\]]*\]/.test(contents)) {
    return contents.replace(/\\usepath\s*\[[^\]]*\]/, line);
  }
  if (/^\\start\w+/.test(contents)) {
    return contents.replace(/^(\\start\w+[^\n]*\n)/, `$1\n${line}\n`);
  }
  return `${line}\n\n${contents}`;
}

function chapterTitle(stem: string): string {
  const bare = stem.replace(/^(component_|chapter-)/, '').replace(/[-_]/g, ' ');
  return bare.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Chapter';
}

export function envLoadLines(envStems: string[]): string {
  return envStems.map((e) => `\\environment ${e}`).join('\n');
}

export function environmentContents(stem: string): string {
  return [
    `\\startenvironment ${stem}`,
    '',
    '% Shared setup (fonts, layout, headings, language, macros, …)',
    '',
    '\\stopenvironment',
    '',
  ].join('\n');
}

export function singleDocumentContents(body = '% Document body'): string {
  return [
    '\\startdocument',
    '',
    body,
    '',
    '\\stopdocument',
    '',
  ].join('\n');
}

export function envDocContents(envStems: string[], body = '% Document body'): string {
  return [
    envLoadLines(envStems),
    '',
    '\\startdocument',
    '',
    body,
    '',
    '\\stopdocument',
    '',
  ].join('\n');
}

export function productContents(
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

export function componentContents(
  componentStem: string,
  envStems: string[],
  body?: string,
): string {
  const title = chapterTitle(componentStem);
  const chapterBody = body ?? '% Chapter body';
  return [
    `\\startcomponent ${componentStem}`,
    '',
    envLoadLines(envStems),
    '',
    `\\startchapter[title={${title}}]`,
    '',
    chapterBody,
    '',
    '\\stopchapter',
    '',
    '\\stopcomponent',
    '',
  ].join('\n');
}

export function projectContents(
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

export function pushFile(
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
  const seenDirs = new Set<string>();
  const sorted = [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  for (const f of sorted) {
    const parts = f.relativePath.split('/');
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const indent = '|   '.repeat(i);
      if (isFile) {
        lines.push(`${indent}|-- ${parts[i]}`);
      } else {
        const dirKey = parts.slice(0, i + 1).join('/');
        if (!seenDirs.has(dirKey)) {
          seenDirs.add(dirKey);
          lines.push(`${indent}|-- ${parts[i]}/`);
        }
      }
    }
  }
  return lines;
}

function appendSpecFile(
  files: PlannedFile[],
  scaffoldRoot: string,
  opts: {
    tier: StructureTier;
    rootFileAbs: string;
    layout: DirectoryLayout;
    environments: string[];
    createdBy: StructureSpecCreatedBy;
    now?: Date;
  },
): void {
  const spec = buildStructureSpec({
    tier: opts.tier,
    rootFile: relativeRootFile(scaffoldRoot, opts.rootFileAbs),
    layout: opts.layout,
    environments: opts.tier === 'single' ? undefined : opts.environments,
    createdBy: opts.createdBy,
    now: opts.now,
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
 * Build a dry-run / apply plan for one wiki §1 tier.
 * Never writes to disk; never inserts `% !TEX root`.
 * Always includes `.context/structure.json` with compile root = product/document.
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
  const layout = resolveDirectoryLayout(input.tier, input.layout);
  const byRole = layout === 'by-role';
  const scaffoldRoot = path.resolve(input.baseDir, name);
  const exists = existsChecker(input.existingPaths);
  const createdBy = input.createdBy ?? 'context.projectManager.create';

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
        const envRel = byRole ? `environments/${env}${ext}` : `${env}${ext}`;
        pushFile(
          files,
          scaffoldRoot,
          envRel,
          environmentContents(env),
          'environment',
        );
      }
      const docRel = `${name}${ext}`;
      let docContents = envDocContents(envStems);
      if (byRole) {
        docContents = withUsePath(docContents, ['environments']);
      }
      pushFile(files, scaffoldRoot, docRel, docContents, 'document');
      rootFile = path.join(scaffoldRoot, docRel);
      break;
    }
    case 'product': {
      for (const env of envStems) {
        const envRel = byRole ? `environments/${env}${ext}` : `${env}${ext}`;
        pushFile(
          files,
          scaffoldRoot,
          envRel,
          environmentContents(env),
          'environment',
        );
      }
      const prodStem = productFileStem(name, prefixed);
      // Scaffold folder is the product folder — product .tex at root (no products/).
      const prodRel = `${prodStem}${ext}`;
      const compFileStems = componentStems.map((c) => componentFileStem(c, prefixed));
      let prodContents = productContents(prodStem, envStems, compFileStems);
      if (byRole) {
        // Compile cwd = scaffold root; reach role folders beside the product.
        prodContents = withUsePath(prodContents, ['environments', 'components']);
      }
      pushFile(files, scaffoldRoot, prodRel, prodContents, 'product');
      rootFile = path.join(scaffoldRoot, prodRel);
      for (let i = 0; i < componentStems.length; i++) {
        const fileStem = compFileStems[i];
        const compRel = byRole
          ? `components/${fileStem}${ext}`
          : `${fileStem}${ext}`;
        let compContents = componentContents(fileStem, envStems);
        if (byRole) {
          // cwd = components/; env folder + parent (sibling components live here).
          compContents = withUsePath(compContents, ['..', '../environments']);
        }
        pushFile(files, scaffoldRoot, compRel, compContents, 'component');
      }
      break;
    }
    case 'project': {
      for (const env of envStems) {
        const envRel = byRole ? `environments/${env}${ext}` : `${env}${ext}`;
        pushFile(
          files,
          scaffoldRoot,
          envRel,
          environmentContents(env),
          'environment',
        );
      }
      const projStem = projectFileStem(name);
      const productList = productStems.map((p) => productFileStem(p, prefixed));
      let projContents = projectContents(projStem, envStems, productList);
      if (byRole) {
        projContents = withUsePath(projContents, ['environments']);
      }
      pushFile(
        files,
        scaffoldRoot,
        `${projStem}${ext}`,
        projContents,
        'project',
      );
      const compFileStems = componentStems.map((c) => componentFileStem(c, prefixed));
      for (const p of productStems) {
        const prodStem = productFileStem(p, prefixed);
        const dir = p; // product stem as folder at series root (not under products/)
        let prodContents = productContents(prodStem, envStems, compFileStems, {
          projectStem: projStem,
        });
        if (byRole) {
          prodContents = withUsePath(prodContents, [
            '../environments',
            'components',
          ]);
        }
        pushFile(
          files,
          scaffoldRoot,
          `${dir}/${prodStem}${ext}`,
          prodContents,
          'product',
        );
        for (const fileStem of compFileStems) {
          const compRel = byRole
            ? `${dir}/components/${fileStem}${ext}`
            : `${dir}/${fileStem}${ext}`;
          let compContents = componentContents(fileStem, envStems);
          if (byRole) {
            compContents = withUsePath(compContents, ['../../environments']);
          }
          pushFile(files, scaffoldRoot, compRel, compContents, 'component');
        }
      }
      // Compile root: first product file (never the coordination project file)
      const firstProd = files.find((f) => f.role === 'product');
      rootFile = firstProd?.path ?? '';
      if (!rootFile) {
        throw new Error('project-tier plan must include a product compile root');
      }
      break;
    }
    default: {
      const _exhaustive: never = input.tier;
      throw new Error(`Unknown tier: ${_exhaustive}`);
    }
  }

  appendSpecFile(files, scaffoldRoot, {
    tier: input.tier,
    rootFileAbs: rootFile,
    layout,
    environments: envStems,
    createdBy,
    now: input.now,
  });

  // Safety: generated contents must not inject magic root comments
  for (const f of files) {
    if (f.role !== 'spec' && /%\s*!TEX\s+root/i.test(f.contents)) {
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
    layout,
  };
}

/** Serialize a plan for the webview dry-run step. */
export function planToDryRunJson(plan: StructurePlan): {
  tier: StructureTier;
  scaffoldRoot: string;
  rootFile: string;
  layout: DirectoryLayout;
  conflicts: string[];
  treeLines: string[];
  files: { relativePath: string; role: PlannedFileRole }[];
  deletePaths?: string[];
} {
  return {
    tier: plan.tier,
    scaffoldRoot: plan.scaffoldRoot,
    rootFile: plan.rootFile,
    layout: plan.layout,
    conflicts: plan.conflicts,
    treeLines: plan.treeLines,
    files: plan.files.map((f) => ({
      relativePath: f.relativePath,
      role: f.role,
    })),
    deletePaths: plan.deletePaths,
  };
}

/** Extract body text between \\startdocument … \\stopdocument (best-effort). */
export function extractDocumentBody(tex: string): string {
  const m = /\\startdocument\b([\s\S]*?)\\stopdocument\b/.exec(tex);
  if (m) {
    return m[1].replace(/^\s*\n/, '').replace(/\n\s*$/, '') || '% Document body';
  }
  return tex.trim() || '% Document body';
}

/** Ensure a product file declares \\project <stem> (idempotent). */
export function ensureProjectDirective(tex: string, projectStem: string): string {
  if (new RegExp(`\\\\project\\s+${escapeRegExp(projectStem)}\\b`).test(tex)) {
    return tex;
  }
  if (/\\project\s+\S+/.test(tex)) {
    return tex.replace(/\\project\s+\S+/, `\\project ${projectStem}`);
  }
  return tex.replace(
    /(\\startproduct\s+\S+[^\n]*\n)/,
    `$1\n\\project ${projectStem}\n`,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
