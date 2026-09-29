import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recommendTier,
  tierOverrideWarning,
  type NeedAnswers,
} from '../projectManager/structureTiers';
import { buildStructurePlan, planToDryRunJson } from '../projectManager/structurePlan';
import { buildUpgradePlan } from '../projectManager/structureUpgrade';
import {
  parseStructureSpecText,
  findStructureSpec,
  nextStructureTier,
} from '../projectManager/structureSpec';
import { scanStructure } from '../project/structureScan';
import { buildProjectModel } from '../project/projectModel';
import { resolveIncludePath } from '../project/pathResolve';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-pm-'));
}

describe('recommendTier', () => {
  it('maps needs to the lowest matching §1 tier', () => {
    assert.equal(
      recommendTier({
        sharedSetup: false,
        splitParts: false,
        severalOutputs: false,
      }).tier,
      'single',
    );
    assert.equal(
      recommendTier({
        sharedSetup: true,
        splitParts: false,
        severalOutputs: false,
      }).tier,
      'env-doc',
    );
    assert.equal(
      recommendTier({
        sharedSetup: true,
        splitParts: true,
        severalOutputs: false,
      }).tier,
      'product',
    );
    assert.equal(
      recommendTier({
        sharedSetup: false,
        splitParts: true,
        severalOutputs: false,
      }).tier,
      'product',
    );
    assert.equal(
      recommendTier({
        sharedSetup: true,
        splitParts: true,
        severalOutputs: true,
      }).tier,
      'project',
    );
  });

  it('warns when choosing project without multi-product need (§13.1)', () => {
    const warn = tierOverrideWarning('product', 'project');
    assert.ok(warn);
    assert.match(warn!, /project tier too early|§13\.1/i);
    assert.equal(tierOverrideWarning('project', 'project'), undefined);
  });
});

describe('buildStructurePlan', () => {
  it('builds wiki §4 flat book tree for product tier', async () => {
    const dir = await tempDir();
    const plan = buildStructurePlan({
      tier: 'product',
      baseDir: dir,
      name: 'book',
    });
    const rels = plan.files.map((f) => f.relativePath).sort();
    assert.deepEqual(rels, [
      '.context/structure.json',
      'book.tex',
      'chapter-01.tex',
      'chapter-02.tex',
      'env_book.tex',
    ]);
    assert.equal(plan.rootFile, path.join(dir, 'book', 'book.tex'));
    const specFile = plan.files.find((f) => f.role === 'spec')!;
    const spec = JSON.parse(specFile.contents);
    assert.equal(spec.schemaVersion, 1);
    assert.equal(spec.tier, 'product');
    assert.equal(spec.rootFile, 'book.tex');
    assert.deepEqual(spec.environments, ['env_book']);
    assert.equal(spec.createdBy, 'context.projectManager.create');
    assert.doesNotMatch(specFile.contents, /project_book/);
    assert.deepEqual(plan.treeLines[0], 'book/');
    const product = plan.files.find((f) => f.role === 'product')!;
    assert.match(product.contents, /\\startproduct book/);
    assert.match(product.contents, /\\environment env_book/);
    assert.match(product.contents, /\\component chapter-01/);
    assert.doesNotMatch(product.contents, /\\startdocument/);
    assert.doesNotMatch(product.contents, /%!TEX\s+root/i);

    const chap = plan.files.find((f) => f.relativePath === 'chapter-01.tex')!;
    assert.match(chap.contents, /\\environment env_book/);
    assert.match(chap.contents, /\\startchapter/);
    assert.doesNotMatch(chap.contents, /\\startdocument/);
  });

  it('builds wiki §5 series tree for project tier', async () => {
    const dir = await tempDir();
    const plan = buildStructurePlan({
      tier: 'project',
      baseDir: dir,
      name: 'series',
    });
    const rels = plan.files.map((f) => f.relativePath).sort();
    assert.ok(rels.includes('env_series.tex'));
    assert.ok(rels.includes('project_series.tex'));
    assert.ok(rels.includes('book-one/book-one.tex'));
    assert.ok(rels.includes('book-one/chapter-01.tex'));
    assert.ok(rels.includes('book-two/book-two.tex'));
    const project = plan.files.find((f) => f.role === 'project')!;
    assert.match(project.contents, /\\startproject project_series/);
    assert.match(project.contents, /\\product book-one/);
    const prod = plan.files.find((f) => f.relativePath === 'book-one/book-one.tex')!;
    assert.match(prod.contents, /\\project project_series/);
    assert.doesNotMatch(prod.contents, /\\startdocument/);
    assert.equal(plan.rootFile, path.join(dir, 'series', 'book-one', 'book-one.tex'));
    const spec = JSON.parse(plan.files.find((f) => f.role === 'spec')!.contents);
    assert.equal(spec.tier, 'project');
    assert.equal(spec.rootFile, 'book-one/book-one.tex');
    assert.ok(!String(spec.rootFile).includes('project_series'));
  });

  it('uses \\startdocument for single and env-doc only', async () => {
    const dir = await tempDir();
    const single = buildStructurePlan({ tier: 'single', baseDir: dir, name: 'note' });
    assert.match(single.files[0].contents, /\\startdocument/);
    assert.match(single.files[0].contents, /\\stopdocument/);

    const envDoc = buildStructurePlan({ tier: 'env-doc', baseDir: dir, name: 'essay' });
    const doc = envDoc.files.find((f) => f.role === 'document')!;
    assert.match(doc.contents, /\\environment env_essay/);
    assert.match(doc.contents, /\\startdocument/);
  });

  it('preserves layered environment order in all loaders', async () => {
    const dir = await tempDir();
    const plan = buildStructurePlan({
      tier: 'product',
      baseDir: dir,
      name: 'book',
      environments: ['env_fonts', 'env_layout'],
    });
    const product = plan.files.find((f) => f.role === 'product')!;
    const envIdx = product.contents.indexOf('\\environment env_fonts');
    const layoutIdx = product.contents.indexOf('\\environment env_layout');
    assert.ok(envIdx >= 0 && layoutIdx > envIdx);
    const chap = plan.files.find((f) => f.role === 'component')!;
    assert.match(chap.contents, /\\environment env_fonts\n\\environment env_layout/);
    assert.equal(plan.files.filter((f) => f.role === 'environment').length, 2);
  });

  it('detects conflicts and never plans % !TEX root', async () => {
    const dir = await tempDir();
    const existing = path.join(dir, 'book', 'book.tex');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, 'old\n');
    const plan = buildStructurePlan({
      tier: 'product',
      baseDir: dir,
      name: 'book',
      existingPaths: [existing],
    });
    assert.ok(plan.conflicts.includes(existing));
    for (const f of plan.files) {
      assert.doesNotMatch(f.contents, /%!?\s*TEX\s+root/i);
    }
    const dry = planToDryRunJson(plan);
    assert.equal(dry.conflicts.length, 1);
  });

  it('scanStructure accepts generated forms including multiple envs', async () => {
    const dir = await tempDir();
    const plan = buildStructurePlan({
      tier: 'product',
      baseDir: dir,
      name: 'book',
      environments: ['env_a', 'env_b'],
    });
    for (const f of plan.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.contents);
    }
    const productText = fs.readFileSync(plan.rootFile, 'utf8');
    const scan = scanStructure(productText);
    assert.equal(scan.fileRole?.role, 'product');
    const envs = scan.includes.filter((i) => i.kind === 'environment').map((i) => i.name);
    assert.deepEqual(envs, ['env_a', 'env_b']);

    const model = buildProjectModel({
      entryFile: plan.rootFile,
      workspaceFolders: [path.join(dir, 'book')],
    });
    const envNodes = model.roots[0].children.filter((c) => c.kind === 'environment');
    assert.equal(envNodes.length, 2);
    assert.equal(envNodes[0].fsPath, path.join(dir, 'book', 'env_a.tex'));
    assert.equal(envNodes[1].fsPath, path.join(dir, 'book', 'env_b.tex'));
  });

  it('project scaffold resolves via §5 subdirectory product layout', async () => {
    const dir = await tempDir();
    const plan = buildStructurePlan({
      tier: 'project',
      baseDir: dir,
      name: 'series',
    });
    for (const f of plan.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.contents);
    }
    const projectFile = plan.files.find((f) => f.role === 'project')!.path;
    const hit = resolveIncludePath({
      fromFile: projectFile,
      name: 'book-one',
    });
    assert.equal(hit, path.join(dir, 'series', 'book-one', 'book-one.tex'));

    const model = buildProjectModel({
      entryFile: plan.rootFile,
      workspaceFolders: [path.join(dir, 'series')],
    });
    assert.ok(model.roots.length >= 1);
    // Entry is product; should climb to project and list products
    const kinds = model.roots.map((r) => r.kind);
    assert.ok(kinds.includes('project') || kinds.includes('product'));
  });
});

describe('need answers exhaustiveness', () => {
  it('covers the four checklist combinations used in the wizard', () => {
    const cases: NeedAnswers[] = [
      { sharedSetup: false, splitParts: false, severalOutputs: false },
      { sharedSetup: true, splitParts: false, severalOutputs: false },
      { sharedSetup: false, splitParts: true, severalOutputs: false },
      { sharedSetup: false, splitParts: false, severalOutputs: true },
    ];
    const tiers = cases.map((c) => recommendTier(c).tier);
    assert.deepEqual(tiers, ['single', 'env-doc', 'product', 'project']);
  });
});

describe('structure spec + upgrade', () => {
  it('validates JSON and rejects bad specs', () => {
    const ok = parseStructureSpecText(
      JSON.stringify({
        schemaVersion: 1,
        tier: 'single',
        rootFile: 'note.tex',
      }),
    );
    assert.equal(ok.ok, true);
    const bad = parseStructureSpecText('{"tier":"single"}');
    assert.equal(bad.ok, false);
  });

  it('upgrades single → env-doc preserving body', async () => {
    const dir = await tempDir();
    const created = buildStructurePlan({
      tier: 'single',
      baseDir: dir,
      name: 'note',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    for (const f of created.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(
        f.path,
        f.role === 'document'
          ? '\\startdocument\n\nHello body\n\n\\stopdocument\n'
          : f.contents,
      );
    }
    const found = findStructureSpec(path.join(dir, 'note'));
    assert.ok(found);
    const upgrade = buildUpgradePlan({
      scaffoldRoot: found!.scaffoldRoot,
      spec: found!.spec,
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    assert.equal(upgrade.tier, 'env-doc');
    const doc = upgrade.files.find((f) => f.role === 'document')!;
    assert.match(doc.contents, /\\environment env_note/);
    assert.match(doc.contents, /Hello body/);
    const spec = JSON.parse(upgrade.files.find((f) => f.role === 'spec')!.contents);
    assert.equal(spec.tier, 'env-doc');
    assert.equal(spec.createdBy, 'context.projectManager.upgrade');
    assert.equal(spec.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(nextStructureTier('env-doc'), 'product');
  });

  it('upgrades env-doc → product (replaces document path with product)', async () => {
    const dir = await tempDir();
    const created = buildStructurePlan({
      tier: 'env-doc',
      baseDir: dir,
      name: 'essay',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    for (const f of created.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.contents);
    }
    const found = findStructureSpec(path.join(dir, 'essay'));
    assert.ok(found);
    const upgrade = buildUpgradePlan({
      scaffoldRoot: found!.scaffoldRoot,
      spec: found!.spec,
    });
    assert.equal(upgrade.tier, 'product');
    const product = upgrade.files.find((f) => f.role === 'product')!;
    assert.equal(product.relativePath, 'essay.tex');
    assert.match(product.contents, /\\startproduct essay/);
    assert.match(product.contents, /\\component chapter-01/);
    assert.ok(upgrade.files.some((f) => f.relativePath === 'chapter-01.tex'));
    // Same path as the former document — overwrite, do not delete
    assert.equal(upgrade.deletePaths, undefined);
    assert.equal(path.basename(upgrade.rootFile), 'essay.tex');
    const spec = JSON.parse(upgrade.files.find((f) => f.role === 'spec')!.contents);
    assert.equal(spec.tier, 'product');
    assert.equal(spec.rootFile, 'essay.tex');
  });

  it('upgrades product → project tier with an extra product; root stays a product', async () => {
    const dir = await tempDir();
    const created = buildStructurePlan({
      tier: 'product',
      baseDir: dir,
      name: 'book',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    for (const f of created.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.contents);
    }
    const found = findStructureSpec(path.join(dir, 'book'));
    assert.ok(found);
    const upgrade = buildUpgradePlan({
      scaffoldRoot: found!.scaffoldRoot,
      spec: found!.spec,
      additionalProducts: ['book-two'],
    });
    assert.equal(upgrade.tier, 'project');
    const proj = upgrade.files.find((f) => f.role === 'project')!;
    assert.match(proj.contents, /\\startproject project_book/);
    assert.match(proj.contents, /\\product book/);
    assert.match(proj.contents, /\\product book-two/);
    const prod = upgrade.files.find((f) => f.relativePath === 'book.tex')!;
    assert.match(prod.contents, /\\project project_book/);
    assert.ok(upgrade.files.some((f) => f.relativePath === 'book-two/book-two.tex'));
    assert.equal(upgrade.rootFile, path.join(dir, 'book', 'book.tex'));
    const spec = JSON.parse(upgrade.files.find((f) => f.role === 'spec')!.contents);
    assert.equal(spec.rootFile, 'book.tex');
    assert.doesNotMatch(spec.rootFile, /project_/);
  });
});
