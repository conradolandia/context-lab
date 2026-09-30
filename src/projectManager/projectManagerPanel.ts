/**
 * Webview wizard for ConTeXt: New Document Structure…
 * Steps: Need → Recommend → Names → Preview → Create
 */

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  ROLE_RULES,
  TIER_INFO,
  TIER_LADDER,
  recommendTier,
  tierOverrideWarning,
  type NeedAnswers,
  type StructureTier,
} from './structureTiers';
import {
  buildStructurePlan,
  planToDryRunJson,
  type StructurePlanInput,
} from './structurePlan';
import type { DirectoryLayout } from './structureSpec';
import { applyStructurePlan } from './applyPlan';
import { runStructureUpgrade } from './upgradeCommand';

export interface ProjectManagerPanelDeps {
  extensionContext: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  refreshProjectView?: () => void;
}

type HostToWeb =
  | { type: 'init'; defaults: WizardDefaults; tiers: typeof TIER_INFO; rules: typeof ROLE_RULES; ladder: StructureTier[] }
  | { type: 'recommend'; recommendation: ReturnType<typeof recommendTier>; warning?: string }
  | { type: 'preview'; dryRun: ReturnType<typeof planToDryRunJson>; warning?: string; error?: string }
  | { type: 'created'; rootFile: string }
  | { type: 'error'; message: string };

interface WizardDefaults {
  name: string;
  baseDir: string;
  extension: string;
  usePrefixedNames: boolean;
  setRootFileOnCreate: boolean;
  layout: DirectoryLayout;
  environments: string;
  components: string;
  products: string;
}

type WebToHost =
  | { type: 'ready' }
  | { type: 'recommend'; answers: NeedAnswers; chosenTier?: StructureTier }
  | {
      type: 'preview';
      answers: NeedAnswers;
      tier: StructureTier;
      name: string;
      baseDir: string;
      environments: string;
      components: string;
      products: string;
      usePrefixedNames: boolean;
      layout: DirectoryLayout;
    }
  | {
      type: 'create';
      answers: NeedAnswers;
      tier: StructureTier;
      name: string;
      baseDir: string;
      environments: string;
      components: string;
      products: string;
      usePrefixedNames: boolean;
      layout: DirectoryLayout;
      setRootFile: boolean;
      overwriteConfirmed?: boolean;
    }
  | { type: 'pickFolder' }
  | { type: 'cancel' }
  | { type: 'openFolder' };

function splitList(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cfgDefaults(): WizardDefaults {
  const cfg = vscode.workspace.getConfiguration('context');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return {
    name: 'book',
    baseDir: folder,
    extension: cfg.get<string>('projectManager.defaultExtension', '.tex') || '.tex',
    usePrefixedNames: cfg.get<boolean>('projectManager.usePrefixedNames', false),
    setRootFileOnCreate: cfg.get<boolean>('projectManager.setRootFileOnCreate', true),
    layout: 'flat',
    environments: '',
    components: 'chapter-01, chapter-02',
    products: 'book-one, book-two',
  };
}

function planInputFromMessage(msg: {
  tier: StructureTier;
  name: string;
  baseDir: string;
  environments: string;
  components: string;
  products: string;
  usePrefixedNames: boolean;
  layout?: DirectoryLayout;
}): StructurePlanInput {
  const envs = splitList(msg.environments);
  const components = splitList(msg.components);
  const products = splitList(msg.products);
  const layout: DirectoryLayout =
    msg.layout === 'by-role' ? 'by-role' : 'flat';
  return {
    tier: msg.tier,
    name: msg.name.trim() || 'book',
    baseDir: msg.baseDir.trim() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
    environments: envs.length ? envs : undefined,
    components: components.length ? components : undefined,
    products: products.length ? products : undefined,
    usePrefixedNames: msg.usePrefixedNames,
    layout,
    extension: '.tex',
    existingPaths: (abs) => fs.existsSync(abs),
  };
}

export class ProjectManagerPanel {
  public static readonly viewType = 'context.projectManager';

  private static current: ProjectManagerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly deps: ProjectManagerPanelDeps;
  private disposables: vscode.Disposable[] = [];

  public static show(deps: ProjectManagerPanelDeps): void {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window
        .showInformationMessage(
          'Open a folder to create a ConTeXt document structure.',
          'Open Folder…',
        )
        .then((choice) => {
          if (choice === 'Open Folder…') {
            void vscode.commands.executeCommand('vscode.openFolder');
          }
        });
      return;
    }

    if (ProjectManagerPanel.current) {
      ProjectManagerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ProjectManagerPanel.viewType,
      'New ConTeXt Document Structure',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(deps.extensionContext.extensionUri, 'media', 'projectManager'),
        ],
      },
    );

    ProjectManagerPanel.current = new ProjectManagerPanel(panel, deps);
  }

  private constructor(panel: vscode.WebviewPanel, deps: ProjectManagerPanelDeps) {
    this.panel = panel;
    this.deps = deps;
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebToHost) => {
        void this.onMessage(msg);
      },
      null,
      this.disposables,
    );
  }

  private post(msg: HostToWeb): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: WebToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          defaults: cfgDefaults(),
          tiers: TIER_INFO,
          rules: ROLE_RULES,
          ladder: TIER_LADDER,
        });
        return;
      case 'openFolder':
        void vscode.commands.executeCommand('vscode.openFolder');
        return;
      case 'cancel':
        this.panel.dispose();
        return;
      case 'pickFolder': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Use folder',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (uris?.[0]) {
          this.post({
            type: 'init',
            defaults: { ...cfgDefaults(), baseDir: uris[0].fsPath },
            tiers: TIER_INFO,
            rules: ROLE_RULES,
            ladder: TIER_LADDER,
          });
        }
        return;
      }
      case 'recommend': {
        const recommendation = recommendTier(msg.answers);
        const chosen = msg.chosenTier ?? recommendation.tier;
        const warning =
          tierOverrideWarning(recommendation.tier, chosen) ?? recommendation.warning;
        this.post({ type: 'recommend', recommendation, warning });
        return;
      }
      case 'preview': {
        try {
          if (!msg.baseDir.trim()) {
            this.post({
              type: 'preview',
              dryRun: {
                tier: msg.tier,
                scaffoldRoot: '',
                rootFile: '',
                layout: 'flat',
                conflicts: [],
                treeLines: [],
                files: [],
              },
              error: 'Choose a base folder for the scaffold.',
            });
            return;
          }
          const plan = buildStructurePlan(planInputFromMessage(msg));
          const rec = recommendTier(msg.answers);
          const warning = tierOverrideWarning(rec.tier, msg.tier) ?? rec.warning;
          this.post({
            type: 'preview',
            dryRun: planToDryRunJson(plan),
            warning,
          });
        } catch (err) {
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'create': {
        try {
          const plan = buildStructurePlan(planInputFromMessage(msg));
          const result = await applyStructurePlan({
            plan,
            setRootFile: msg.setRootFile,
            overwriteConfirmed: msg.overwriteConfirmed === true,
            extensionContext: this.deps.extensionContext,
            output: this.deps.output,
            refreshProjectView: this.deps.refreshProjectView,
          });
          if (!result.ok) {
            if (result.reason === 'cancelled') {
              this.post({ type: 'error', message: result.message });
              return;
            }
            this.post({ type: 'error', message: result.message });
            return;
          }
          this.post({ type: 'created', rootFile: result.rootFile });
          this.panel.dispose();
        } catch (err) {
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private dispose(): void {
    ProjectManagerPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>New ConTeXt Document Structure</title>
<style>
  :root {
    color-scheme: light dark;
    --gap: 12px;
    --radius: 4px;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 16px 20px 32px;
    line-height: 1.45;
    max-width: 720px;
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 4px; }
  .sub { opacity: 0.85; margin-bottom: 16px; }
  .principle {
    border-left: 3px solid var(--vscode-focusBorder, #3794ff);
    padding: 8px 12px;
    margin: 0 0 16px;
    background: var(--vscode-textBlockQuote-background, transparent);
  }
  .steps {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-bottom: 16px; padding: 0; list-style: none;
  }
  .steps li {
    padding: 2px 8px;
    border-radius: var(--radius);
    opacity: 0.55;
    border: 1px solid transparent;
  }
  .steps li.on {
    opacity: 1;
    border-color: var(--vscode-focusBorder, #3794ff);
    background: var(--vscode-toolbar-hoverBackground, transparent);
  }
  section { display: none; }
  section.active { display: block; }
  label.row {
    display: flex; align-items: flex-start; gap: 8px;
    margin: 8px 0; cursor: pointer;
  }
  label.block { display: block; margin: 10px 0 4px; font-weight: 600; }
  input[type="text"], textarea, select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px 8px; border-radius: var(--radius);
  }
  textarea { min-height: 56px; font-family: var(--vscode-editor-font-family, monospace); }
  .row-inline { display: flex; gap: 8px; align-items: center; }
  .row-inline input[type="text"] { flex: 1; }
  button, .btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: var(--radius);
    cursor: pointer; font: inherit;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .ladder { margin: 12px 0; padding-left: 18px; }
  .ladder li { margin: 4px 0; }
  .ladder li.pick { font-weight: 600; }
  .warn {
    margin: 12px 0; padding: 8px 10px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
    background: var(--vscode-inputValidation-warningBackground, transparent);
  }
  .err {
    margin: 12px 0; padding: 8px 10px;
    border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c);
    background: var(--vscode-inputValidation-errorBackground, transparent);
  }
  .ok {
    margin: 12px 0; padding: 8px 10px;
    border: 1px solid var(--vscode-focusBorder, #3794ff);
  }
  pre.tree {
    background: var(--vscode-textCodeBlock-background, transparent);
    padding: 10px 12px; overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  .conflict { color: var(--vscode-errorForeground, #f14c4c); }
  table.rules { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  table.rules th, table.rules td {
    text-align: left; padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .hint { opacity: 0.8; font-size: 0.92em; margin: 4px 0 0; }
</style>
</head>
<body>
  <h1>New ConTeXt document structure</h1>
  <p>Wizard based on the <a href="https://wiki.contextgarden.net/Input_and_compilation/Project_and_file_management">ConTeXt Project and file management</a> article.</p>
  <blockquote class="principle">
    Do not introduce a project-tier coordination file merely because a document contains several files.
    Use the simplest structure that matches the job. (wiki §1)
  </blockquote>

  <ol class="steps" id="stepper">
    <li data-step="0">Need</li>
    <li data-step="1">Recommend</li>
    <li data-step="2">Names</li>
    <li data-step="3">Preview</li>
  </ol>

  <div id="banner"></div>

  <section id="step-need" class="active">
    <p>What do you need?</p>
    <label class="row"><input type="checkbox" id="sharedSetup" /> Shared / substantial setup (fonts, layout, macros)</label>
    <label class="row"><input type="checkbox" id="splitParts" /> One output split into reusable parts (chapters, articles)</label>
    <label class="row"><input type="checkbox" id="severalOutputs" /> Several related PDFs that must be coordinated</label>
    <table class="rules">
      <thead><tr><th>Use</th><th>When</th></tr></thead>
      <tbody id="rulesBody"></tbody>
    </table>
    <div class="actions">
      <button id="toRecommend">Continue</button>
      <button class="secondary" id="cancel1">Cancel</button>
    </div>
  </section>

  <section id="step-recommend">
    <p id="recReason"></p>
    <ol class="ladder" id="ladder"></ol>
    <label class="block" for="tierSelect">Structure tier</label>
    <select id="tierSelect"></select>
    <p class="hint" id="tierHint"></p>
    <div id="recWarn"></div>
    <div class="actions">
      <button class="secondary" id="backNeed">Back</button>
      <button id="toNames">Continue</button>
      <button class="secondary" id="cancel2">Cancel</button>
    </div>
  </section>

  <section id="step-names">
    <label class="block" for="name">Name (folder / stem)</label>
    <input type="text" id="name" spellcheck="false" />
    <label class="block" for="baseDir">Base folder</label>
    <div class="row-inline">
      <input type="text" id="baseDir" spellcheck="false" />
      <button class="secondary" id="pickFolder" type="button">Browse…</button>
    </div>
    <label class="block" for="environments">Environments (ordered, comma-separated; empty = one env_&lt;name&gt;)</label>
    <input type="text" id="environments" spellcheck="false" placeholder="env_fonts, env_layout" />
    <p class="hint">Layered environments load in this order (wiki §7.1).</p>
    <div id="productFields">
      <label class="block" for="components">Components / chapters</label>
      <input type="text" id="components" spellcheck="false" />
    </div>
    <div id="projectFields">
      <label class="block" for="products">Products (project tier — each builds separately)</label>
      <input type="text" id="products" spellcheck="false" />
      <p class="hint">Compile root is the first product. The coordination <code>\\startproject</code> file is not a build target.</p>
    </div>
    <div id="layoutFields">
      <label class="block">Directory layout</label>
      <label class="row"><input type="radio" name="layout" id="layoutFlat" value="flat" checked /> Flat — wiki §4/§5 default (files beside each other)</label>
      <label class="row"><input type="radio" name="layout" id="layoutByRole" value="by-role" /> By role — <code>environments/</code>, <code>products/</code> or product folders, <code>components/</code> with <code>\\usepath</code></label>
      <p class="hint" id="layoutHint">Hidden for a single document (no-op). Product tier puts the product under <code>products/</code>; project tier keeps each product folder at the series root.</p>
    </div>
    <label class="row"><input type="checkbox" id="usePrefixedNames" /> Prefer denser prefixes (product_*, component_*)</label>
    <label class="row"><input type="checkbox" id="setRootFile" checked /> Set <code>context.rootFile</code> to the compile root (product or document — never the \\startproject file)</label>
    <div class="actions">
      <button class="secondary" id="backRec">Back</button>
      <button id="toPreview">Preview</button>
      <button class="secondary" id="cancel3">Cancel</button>
    </div>
  </section>

  <section id="step-preview">
    <div id="prevWarn"></div>
    <pre class="tree" id="tree"></pre>
    <p id="rootHint" class="hint"></p>
    <div id="conflictBox"></div>
    <div class="actions">
      <button class="secondary" id="backNames">Back</button>
      <button id="createBtn">Create</button>
      <button class="secondary" id="cancel4">Cancel</button>
    </div>
  </section>

<script>
const vscode = acquireVsCodeApi();
let step = 0;
let defaults = null;
let tiers = {};
let ladder = [];
let answers = { sharedSetup: false, splitParts: false, severalOutputs: false };
let recommendation = null;
let lastDryRun = null;
let overwriteConfirmed = false;

function $(id) { return document.getElementById(id); }

function showBanner(kind, text) {
  const el = $('banner');
  if (!text) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="' + kind + '">' + escapeHtml(text) + '</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function setStep(n) {
  step = n;
  document.querySelectorAll('section').forEach((s) => s.classList.remove('active'));
  const ids = ['step-need','step-recommend','step-names','step-preview'];
  $(ids[n]).classList.add('active');
  document.querySelectorAll('#stepper li').forEach((li) => {
    li.classList.toggle('on', Number(li.dataset.step) === n);
  });
  showBanner('', '');
  syncNameFields();
}

function readAnswers() {
  return {
    sharedSetup: $('sharedSetup').checked,
    splitParts: $('splitParts').checked,
    severalOutputs: $('severalOutputs').checked,
  };
}

function syncNameFields() {
  const tier = $('tierSelect').value || 'single';
  $('productFields').style.display = (tier === 'product' || tier === 'project') ? 'block' : 'none';
  $('projectFields').style.display = tier === 'project' ? 'block' : 'none';
  $('layoutFields').style.display = tier === 'single' ? 'none' : 'block';
  const info = tiers[tier];
  if (info) {
    $('tierHint').textContent = info.summary + ' — ' + info.compileHint;
  }
}

function applyDefaults(d) {
  defaults = d;
  $('name').value = d.name;
  $('baseDir').value = d.baseDir;
  $('environments').value = d.environments;
  $('components').value = d.components;
  $('products').value = d.products;
  $('usePrefixedNames').checked = !!d.usePrefixedNames;
  $('setRootFile').checked = d.setRootFileOnCreate !== false;
  const layout = d.layout === 'by-role' ? 'by-role' : 'flat';
  $('layoutFlat').checked = layout === 'flat';
  $('layoutByRole').checked = layout === 'by-role';
}

function readLayout() {
  return $('layoutByRole').checked ? 'by-role' : 'flat';
}

function collectNames() {
  return {
    answers,
    tier: $('tierSelect').value,
    name: $('name').value,
    baseDir: $('baseDir').value,
    environments: $('environments').value,
    components: $('components').value,
    products: $('products').value,
    usePrefixedNames: $('usePrefixedNames').checked,
    layout: readLayout(),
    setRootFile: $('setRootFile').checked,
  };
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    tiers = msg.tiers;
    ladder = msg.ladder;
    applyDefaults(msg.defaults);
    const tb = $('rulesBody');
    tb.innerHTML = '';
    (msg.rules || []).forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><code>' + escapeHtml(r.use) + '</code></td><td>' + escapeHtml(r.when) + '</td>';
      tb.appendChild(tr);
    });
    const sel = $('tierSelect');
    sel.innerHTML = '';
    ladder.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = tiers[id].title + ' (' + tiers[id].wikiSection + ')';
      sel.appendChild(opt);
    });
    sel.onchange = () => {
      syncNameFields();
      vscode.postMessage({ type: 'recommend', answers, chosenTier: sel.value });
    };
  } else if (msg.type === 'recommend') {
    recommendation = msg.recommendation;
    $('recReason').textContent = msg.recommendation.reason;
    const ol = $('ladder');
    ol.innerHTML = '';
    ladder.forEach((id) => {
      const li = document.createElement('li');
      li.textContent = tiers[id].title + ' — ' + tiers[id].summary;
      if (id === msg.recommendation.tier) li.classList.add('pick');
      ol.appendChild(li);
    });
    if (!$('tierSelect').dataset.touched) {
      $('tierSelect').value = msg.recommendation.tier;
    }
    syncNameFields();
    const w = $('recWarn');
    w.innerHTML = msg.warning ? '<div class="warn">' + escapeHtml(msg.warning) + '</div>' : '';
  } else if (msg.type === 'preview') {
    if (msg.error) {
      showBanner('err', msg.error);
      return;
    }
    lastDryRun = msg.dryRun;
    overwriteConfirmed = false;
    $('tree').textContent = (msg.dryRun.treeLines || []).join('\\n');
    $('rootHint').textContent = msg.dryRun.rootFile
      ? 'Compile root (product or document): ' + msg.dryRun.rootFile
      : '';
    const cb = $('conflictBox');
    if (msg.dryRun.conflicts && msg.dryRun.conflicts.length) {
      cb.innerHTML = '<div class="warn conflict">Conflicts (will prompt to overwrite):<br><pre class="tree">' +
        escapeHtml(msg.dryRun.conflicts.join('\\n')) + '</pre></div>';
    } else {
      cb.innerHTML = '<div class="ok">No conflicting files.</div>';
    }
    const pw = $('prevWarn');
    pw.innerHTML = msg.warning ? '<div class="warn">' + escapeHtml(msg.warning) + '</div>' : '';
    setStep(3);
  } else if (msg.type === 'created') {
    showBanner('ok', 'Created. Opened ' + msg.rootFile);
  } else if (msg.type === 'error') {
    showBanner('err', msg.message);
  }
});

$('toRecommend').onclick = () => {
  answers = readAnswers();
  $('tierSelect').dataset.touched = '';
  vscode.postMessage({ type: 'recommend', answers });
  setStep(1);
};
$('backNeed').onclick = () => setStep(0);
$('toNames').onclick = () => {
  $('tierSelect').dataset.touched = '1';
  setStep(2);
  syncNameFields();
};
$('backRec').onclick = () => setStep(1);
$('toPreview').onclick = () => {
  vscode.postMessage({ type: 'preview', ...collectNames() });
};
$('backNames').onclick = () => setStep(2);
$('createBtn').onclick = () => {
  const payload = { type: 'create', ...collectNames() };
  if (lastDryRun && lastDryRun.conflicts && lastDryRun.conflicts.length) {
    payload.overwriteConfirmed = false; // host shows modal
  }
  vscode.postMessage(payload);
};
$('pickFolder').onclick = () => vscode.postMessage({ type: 'pickFolder' });
['cancel1','cancel2','cancel3','cancel4'].forEach((id) => {
  $(id).onclick = () => vscode.postMessage({ type: 'cancel' });
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

/** Register create + upgrade commands. */
export function registerProjectManager(
  context: vscode.ExtensionContext,
  deps: Omit<ProjectManagerPanelDeps, 'extensionContext'>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('context.projectManager.create', () => {
      ProjectManagerPanel.show({
        extensionContext: context,
        output: deps.output,
        refreshProjectView: deps.refreshProjectView,
      });
    }),
    vscode.commands.registerCommand('context.projectManager.upgrade', () => {
      void runStructureUpgrade({
        extensionContext: context,
        output: deps.output,
        refreshProjectView: deps.refreshProjectView,
      });
    }),
  );
}
