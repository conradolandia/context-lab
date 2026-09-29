# ConTeXt Tools

VS Code / Cursor extension for ConTeXt (LMTX): SyncTeX PDF preview, DigestiF language server, Project view, Project Manager (scaffold), a TextMate grammar, and a small snippet set for the `context` language.

**License:** GNU GPL version 2 only (`GPL-2.0-only`). See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Keyword lists are derived from ConTeXt SciTE data (same GPL-2 regime).

## Install

**Marketplace.** Search for **ConTeXt Tools** (`context-lab.context-tools`) when the listing is published, or install from the [repository](https://github.com/conradolandia/context-lab) release assets.

**VSIX (local or CI build):**

```bash
npm install
npm run compile
npx @vscode/vsce package
```

Then **Extensions: Install from VSIX…** and pick the generated `.vsix`.

Requires a working LMTX / ConTeXt Standalone install for build and SyncTeX. DigestiF is optional (completion / hover / outline).

## Settings

`context.root` is the **ConTeXt installation root** (Standalone / LMTX tree root): the directory that contains `tex/`. Binaries live under `$CONTEXT_ROOT/tex/texmf-<platform>/bin/` (`context`, `mtxrun`, `luametatex`, …). See [wiki Structure](https://wiki.contextgarden.net/ConTeXt_Standalone/Structure).

Typical layout:

```text
$CONTEXT_ROOT/                          ← set context.root here (install root)
  tex/
    texmf-<platform>/bin/               ← binaries (context, mtxrun, …)
    texmf-context/…                     ← formats, data, SciTE tables
```

Resolution order:

1. `context.contextPath` / `context.mtxrunPath` (absolute overrides, each independent)
2. Binaries under `context.root` → `{root}/tex/texmf-*/bin/{context,mtxrun}` (and older `bin/` layouts)
3. `context` and `mtxrun` on `PATH` (install root inferred by walking parents until `tex/texmf-context` exists)

`context.root` defaults to empty. PATH installs need no config when the binary realpath sits under a normal Standalone / LMTX tree.

| Setting | Default | Notes |
| --- | --- | --- |
| `context.root` | `""` | ConTeXt installation root (parent of `tex/`) |
| `context.contextPath` | `""` | Absolute `context` binary |
| `context.mtxrunPath` | `""` | Absolute `mtxrun` binary |
| `context.synctex.enabled` | `true` | Toggle SyncTeX |
| `context.build.args` | `[]` | Extra args after `--synctex=repeat` |
| `context.build.onSave` | `false` | Save of a ConTeXt/TeX file starts a build; rapid saves coalesce to one follow-up |
| `context.rootFile` | `""` | Main file to compile (workspace-relative or absolute). Empty = auto-detect |
| `context.digestif.enabled` | `true` | Start DigestiF LSP. Safe to leave on if DigestiF is missing |
| `context.digestifPath` | `""` | Absolute DigestiF binary; empty = `digestif` on PATH / luarocks |
| `context.projectView.enabled` | `true` | Show the ConTeXt activity-bar Project TreeView |
| `context.projectView.includeInputs` | `false` | Show `\input` children under products |
| `context.projectView.includeModules` | `false` | Reserved; modules/figures stay on document links only |
| `context.projectView.maxFiles` | `500` | Cap on files visited while expanding the graph |
| `context.projectView.refreshDebounceMs` | `300` | Debounce before rescan after edits/saves |
| `context.projectManager.defaultExtension` | `".tex"` | Scaffold extension (v1: `.tex` only) |
| `context.projectManager.usePrefixedNames` | `false` | Denser `product_*` / `component_*` prefixes when true |
| `context.projectManager.setRootFileOnCreate` | `true` | Set `context.rootFile` after create to the product/document compile root (no `% !TEX root` in files) |

Example (absolute path; home installs are often `$HOME/context` expanded):

```json
{
  "context.root": "/opt/context"
}
```

### Main (root) file

Order (first match wins):

1. Setting `context.rootFile`
2. Magic comment in the first ~20 lines: `% !TEX root = <path>` (relative to that file)
3. ConTeXt structure: if the active file is a `\startcomponent`, find `\product <name>` and resolve `<name>.tex` nearby / in the workspace
4. Fallback: the active file

The status bar shows `ConTeXt: <rootname>`; click it to set or clear `context.rootFile`. Build / Show PDF use the resolved root’s PDF and synctex; Forward SyncTeX still passes the **active** file and line.

## Commands and SyncTeX shortcuts

| Action | Command / binding |
| --- | --- |
| Build then open/refresh viewer | **ConTeXt: Build and Preview** |
| Show last gated PDF | **ConTeXt: Show PDF** |
| Forward SyncTeX (source → PDF) | **ConTeXt: Forward SyncTeX** — `Ctrl+Alt+J` (macOS: `Cmd+Alt+J`) |
| Backward SyncTeX (PDF → source) | **Ctrl+click** (macOS: **Cmd+click**) in the PDF webview |
| Refresh TextMate command keywords from LMTX | **ConTeXt: Refresh command keywords** (then reload the window) |

Build uses `context --synctex=repeat` plus `context.build.args`.

**SyncTeX notes**

- ConTeXt SyncTeX marks **text**, not pure image areas. Clicks on figures with no text often show a short toast (no source jump).
- Caption clicks may resolve to a coarse line (often line 1). When that happens mid-page with no better match, the extension does not jump; click nearby body text instead.
- mtxrun synctex uses **y top-down**; the viewer converts PDF.js coordinates before `--report`.

## DigestiF and language id

DigestiF is optional. It never blocks build, preview, or SyncTeX. DigestiF logs go to the **ConTeXt DigestiF** output channel; build logs stay on **ConTeXt**.

This extension contributes language id **`context`** (aliases: ConTeXt) for `.mkiv`, `.mkxl`, `.mkvi`, `.mklx`, `.mkii`. It does **not** claim `*.tex` globally.

| languageId | DigestiF format |
| --- | --- |
| `context` | ConTeXt (`context-en.xml` via `DIGESTIF_TEXMF`) |
| `tex` / `latex` | LaTeX |

Use ConTeXt language mode for ConTeXt documents. On Build / Show PDF of a `.tex` file whose language is not `context`, the extension can offer once per workspace:

```json
"files.associations": {
  "*.tex": "context"
}
```

**Recommended DigestiF install (LuaRocks):** DigestiF needs `lpeg` / `lfs`:

```bash
luarocks --local --lua-version 5.4 install digestif LUA_INCDIR=/usr/include/lua5.4
# Ensure ~/.luarocks/bin is on PATH, or set context.digestifPath
```

Launch order: `context.digestifPath` → `~/.luarocks/bin/digestif` → `digestif` on PATH. After one DigestiF failure it stays off until you change `context.digestif*` or reload the window.

## Project view

Activity-bar container **ConTeXt** → **Project**. Scans English structure commands (`\project`, `\product`, `\component`, `\environment`, `\usepath`, optional `\input`). Does not list `\usemodule` or `\externalfigure` (those remain document links).

| Node | Build | Notes |
| --- | --- | --- |
| product / document | yes | Compiles that file |
| component | yes | Compiles via root resolution (product preferred) |
| environment | no | Loaded into a product |
| project | refused | Offers the first listed product if any |

Click a node to open the file. Actions: Build, Forward SyncTeX, Set as Main (Root) File. Title bar: **New Document Structure…**, **Reveal Active**, and **Refresh**.

## Project Manager (document structure)

Command **ConTeXt: New Document Structure…** (`context.projectManager.create`) opens a webview wizard that scaffolds the simplest ConTeXt structure that matches the job (wiki *Project and file management* §1):

| Tier | When | Compile root |
| --- | --- | --- |
| Single document | One file | That file |
| Document + environment | Shared setup | Document file |
| Product + components | One output, split parts (no project tier) | Product file |
| Project tier (§1.4) | Several related products | Each product (never the `\startproject` coordination file) |

After create: writes `.context/structure.json` (tier + default compile root), opens that compile root, sets `context.rootFile` when enabled, refreshes the Project view, and may offer `files.associations["*.tex"] = "context"`. Scaffolds use `.tex` only and do not insert `% !TEX root`. Layered environments (ordered list) are supported.

**Upgrade:** **ConTeXt: Upgrade Document Structure…** (`context.projectManager.upgrade`) moves a scaffold one rung up the §1 ladder when a valid `.context/structure.json` is present. Without a spec, the command refuses and can open the create wizard. Multi-product series still use **one active** `context.rootFile` (a product); switch via the status bar or Project view **Set as Main (Root) File**.

Local LMTX manuals that complement the wiki live under `$CONTEXT_ROOT/tex/texmf-context/doc/` (for example `$HOME/context` or `/opt/context`): `context/documents/general/magazines/mag-1101-mkiv.pdf` and `context/documents/general/manuals/mkiv/workflows-mkiv.pdf`.

## Build on save

`context.build.onSave` (default `false`) starts a build when a ConTeXt/TeX document is saved. While a build runs, further saves queue **one** follow-up build (rapid saves coalesce). A status bar item shows build state and the last duration.

The viewer keeps the last good PDF while a build runs, then reloads after a stability gate on the job PDF (no mid-compile flicker from watching the live file).

## LaTeX Workshop conflict

LaTeX Workshop (`James-Yu.latex-workshop`) from 10.x also contributes language id `context`. VS Code keeps one grammar per language id; when both are enabled, Workshop’s LaTeX grammar often wins for `.mkiv`.

ConTeXt Tools shows a one-shot warning with options to disable Workshop for the workspace, add it to `unwantedRecommendations`, or dismiss. Nothing is auto-disabled without that prompt. Prefer **Disable (Workspace)** for ConTeXt folders. See also this repo’s [`.vscode/extensions.json`](.vscode/extensions.json).

## Snippets

A small built-in set is contributed for language id **`context`** (`snippets/context.code-snippets`). Prefixes: structure stubs (`startproduct`, `startcomponent`, `startenvironment`, `startproject`, `component`, `environment`), document/sectioning (`startdocument`, `startchapter`, `startsection`), and a few environments (`startitemize`, `startnarrower`, `startframed`). Root file selection stays via `context.rootFile` / the status-bar picker, not a snippet.

Snippets appear only when the editor language is `context` (native `.mkiv` / …, or `*.tex` after `"files.associations": { "*.tex": "context" }`).

To add your own without changing the extension:

| Scope | How |
| --- | --- |
| User | **Snippets: Configure User Snippets** → choose **context** (or create `context.json`) |
| Workspace | Add `.vscode/<name>.code-snippets` with `"scope": "context"` on each snippet |

User and workspace snippets merge with the built-in set; same prefix can appear from more than one source.

## Syntax highlighting

The TextMate grammar (`syntaxes/context.tmLanguage.json`, scope `text.tex.context`) colors known ConTeXt names from a committed SciTE keyword snapshot (`syntaxes/context-keywords.json`). After an LMTX upgrade, run **ConTeXt: Refresh command keywords** and reload the window, or regenerate from the command line (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

Folding matches `\start<name>` / `\stop<name>` pairs by name. Build diagnostics parse LMTX console/log lines into the Problems panel.

## Develop

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Coding agents: [`AGENTS.md`](AGENTS.md).
