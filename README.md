# ConTeXt Tools

VS Code / Cursor extension for ConTeXt (LMTX): SyncTeX PDF preview, DigestiF language server, Project view, project-structure scaffolding, TextMate grammar, and snippets for the `context` language.

**License:** GNU GPL version 2 only (`GPL-2.0-only`). See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Keyword lists are derived from ConTeXt SciTE data (same GPL-2 regime).

## Requirements

- VS Code or Cursor
- LMTX / ConTeXt Standalone for build and SyncTeX
- DigestiF (optional) for completion, hover, and outline

## Install

**Marketplace.** Search for **ConTeXt Tools** (`context-lab.context-tools`) when the listing is published, or install from the [repository](https://github.com/conradolandia/context-lab) release assets.

**VSIX:**

```bash
npm install && npm run compile && npx @vscode/vsce package
```

Then **Extensions: Install from VSIX…** and pick the generated `.vsix`.

## Settings

`context.root` is the ConTeXt installation root (parent of `tex/`). Binaries are under `$CONTEXT_ROOT/tex/texmf-<platform>/bin/` (`context`, `mtxrun`, `luametatex`, …). See [wiki Structure](https://wiki.contextgarden.net/ConTeXt_Standalone/Structure).

```text
$CONTEXT_ROOT/                 ← context.root
  tex/
    texmf-<platform>/bin/      ← context, mtxrun, …
    texmf-context/…            ← formats, data, SciTE tables
```

Resolution: absolute `context.contextPath` / `context.mtxrunPath` overrides, then binaries under `context.root`, then `context` / `mtxrun` on `PATH` (install root inferred by walking parents until `tex/texmf-context` exists). Empty `context.root` is fine when PATH already points into a normal Standalone / LMTX tree.

| Setting | Default | Notes |
| --- | --- | --- |
| `context.root` | `""` | ConTeXt installation root (parent of `tex/`) |
| `context.contextPath` | `""` | Absolute `context` binary |
| `context.mtxrunPath` | `""` | Absolute `mtxrun` binary |
| `context.rootFile` | `""` | Main file to compile; empty = auto-detect |
| `context.projectManager.defaultExtension` | `".tex"` | Scaffold extension (`.tex` only) |
| `context.projectManager.usePrefixedNames` | `false` | `product_*` / `component_*` prefixes when true |
| `context.projectManager.setRootFileOnCreate` | `true` | Set `context.rootFile` after create |
| `context.projectView.enabled` | `true` | ConTeXt activity-bar Project TreeView |
| `context.projectView.includeInputs` | `false` | Show `\input` children under products |
| `context.projectView.includeModules` | `false` | Reserved |
| `context.projectView.maxFiles` | `500` | Cap on files visited while expanding the graph |
| `context.projectView.refreshDebounceMs` | `300` | Debounce before rescan after edits/saves |
| `context.build.args` | `[]` | Extra args after `--synctex=repeat` |
| `context.build.onSave` | `false` | Save starts a build; rapid saves coalesce |
| `context.synctex.enabled` | `true` | Toggle SyncTeX |
| `context.viewer.openExistingOnActivate` | `false` | Open existing root PDF+SyncTeX on activate (no rebuild). Default off; use **Show PDF** or Explorer menu |
| `context.debugOutput` | `false` | Verbose traces on **ConTeXt debug** (viewer, gate, SyncTeX dumps) |
| `context.digestif.enabled` | `true` | Start DigestiF LSP |
| `context.digestifPath` | `""` | Absolute DigestiF binary; empty = PATH / luarocks |

```json
{
  "context.root": "/opt/context"
}
```

Home installs are often `$HOME/context`.

### Main (root) file

First match wins:

1. `context.rootFile`
2. Magic comment in the first ~20 lines: `% !TEX root = <path>`
3. Structure: active `\startcomponent` → nearby `\product <name>` → `<name>.tex`
4. Active file

Status bar shows `ConTeXt: <rootname>` (click to set or clear). Build / Show PDF use the resolved root’s PDF and synctex; Forward SyncTeX still uses the **active** file and line.

## Commands and SyncTeX

| Action | Command / binding |
| --- | --- |
| Build then open/refresh viewer | **ConTeXt: Build and Preview** |
| Cancel a running build | **ConTeXt: Cancel Build** (also: click the build status bar while running) |
| Show last gated PDF (no rebuild) | **ConTeXt: Show PDF** (also editor context on ConTeXt/TeX); Explorer → **Open in ConTeXt PDF Viewer** on a job `.pdf` (sibling `.synctex` or active root output) |
| Forward SyncTeX (source → PDF) | **ConTeXt: Forward SyncTeX** — `Ctrl+Alt+J` (macOS: `Cmd+Alt+J`) |
| Backward SyncTeX (PDF → source) | **Ctrl+click** (macOS: **Cmd+click**) in the PDF webview |
| Follow PDF links | Plain click on a link in the PDF webview (internal dest or external URL). Ctrl/Cmd+click stays SyncTeX |
| Zoom PDF | Toolbar **+/-** / **Fit**, editable `%`, **Shift+wheel** (pointer-anchored). Ctrl/Cmd+wheel is left to the viewer/browser |
| Refresh TextMate keywords from LMTX | **ConTeXt: Refresh command keywords** (then reload the window) |

Build uses `context --synctex=repeat` plus `context.build.args`. The viewer keeps the last good PDF while a build runs, then reloads after a stability gate and preserves the current scroll position and zoom (it does not replay the last Forward SyncTeX jump).

SyncTeX marks text, not pure image areas; clicks on figures with no text usually show a short toast. Caption clicks may resolve coarsely. When Forward SyncTeX lands in a thin header/footer band, it prefers a same-line (then nearby-line) box outside that band closest to the mtx hit; it does not paint an unreplaced edge-band box or a page-sized vbox.

## DigestiF

Optional. DigestiF never blocks build, preview, or SyncTeX. Logs go to the **ConTeXt DigestiF** output channel; build logs stay on **ConTeXt**. Set `context.debugOutput` to send viewer / gate / SyncTeX internal traces to **ConTeXt debug**.

Language id **`context`** (aliases: ConTeXt) covers `.mkiv`, `.mkxl`, `.mkvi`, `.mklx`, `.mkii`. The extension does not claim `*.tex` globally. DigestiF maps `context` → ConTeXt tags and `tex` / `latex` → LaTeX. For `.tex` ConTeXt sources, associate them:

```json
"files.associations": {
  "*.tex": "context"
}
```

Install DigestiF via LuaRocks (`lpeg` / `lfs` required), put it on `PATH`, or set `context.digestifPath`. Launch order: `context.digestifPath` → `~/.luarocks/bin/digestif` → `digestif` on PATH.

## Project view

Activity bar **ConTeXt** → **Project**. Scans English structure commands (`\project`, `\product`, `\component`, `\environment`, `\usepath`, optional `\input`). `\usemodule` and `\externalfigure` stay on document links only.

| Node | Build |
| --- | --- |
| product / document | yes |
| component | yes (via root resolution) |
| environment | no |
| project | refused (offers first listed product if any) |

Click a node to open. Actions: Build, Forward SyncTeX, Set as Main (Root) File. Title bar: **New Project Structure…**, **Reveal Active**, **Refresh**. Focusing a `.tex` file does not switch to this view; use **Reveal Active** when you want that.

## Project structure wizard

**ConTeXt: New Project Structure…** scaffolds the simplest structure that matches the job (wiki *Project and file management* §1): single document; document + environment; product + components; or project tier (several products — compile each product, not the `\startproject` file).

After create: writes `.context/structure.json` (tier, optional `layout`, optional `documentStub` / `documentMetadata`, compile root), opens the compile root, sets `context.rootFile` when enabled, refreshes the Project view, and may offer `files.associations["*.tex"] = "context"`. Scaffolds use `.tex` only and do not insert `% !TEX root`.

On the names step (tiers other than single), **Directory layout** is **Flat** (default, wiki §4/§5) or **By role** (`environments/`, product `.tex` at scaffold root or product folders at series root, `components/` with `\usepath`). Absent `layout` means flat; upgrade preserves it.

For **product** and **project** tiers, an optional checkbox includes a `\startdocument` metadata stub in each product file (components stay between `\startdocument` / `\stopdocument`). Metadata is entered as `key=value` lines. Off by default; hidden for `single` / `env-doc` (those already use `\startdocument`).

**ConTeXt: Upgrade Project Structure…** moves a scaffold one rung up when `.context/structure.json` is present.

## Snippets

Built-in snippets for language id **`context`**: structure stubs (`startproduct`, `startcomponent`, …), sectioning (`startdocument`, `startchapter`, …), and common environments (`startitemize`, `startplaceformula`, `starttyping`, …). Each trigger is registered with and without a leading `\`, so accepting after typing `\` does not leave a doubled backslash. Environment-like `\start…` snippets insert a matching `\stop…` with the cursor between them. Load commands (`component`, `environment`) stay one-liners. They appear only when the editor language is `context`.

User/workspace snippets: **Snippets: Configure User Snippets** → **context**, or `.vscode/<name>.code-snippets` with `"scope": "context"`.

## Syntax highlighting

TextMate grammar colors known ConTeXt names from a committed SciTE keyword snapshot. After an LMTX upgrade, run **ConTeXt: Refresh command keywords** and reload, or regenerate from the command line (see [`CONTRIBUTING.md`](CONTRIBUTING.md)). Folding matches `\start<name>` / `\stop<name>` pairs. Build diagnostics appear in the Problems panel.

## LaTeX Workshop

LaTeX Workshop (`James-Yu.latex-workshop`) from 10.x also contributes language id `context`. When both are enabled, Workshop’s grammar often wins for `.mkiv`. ConTeXt Tools shows a one-shot warning with disable / dismiss options; nothing is auto-disabled without that prompt.

## Develop

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Coding agents: [`AGENTS.md`](AGENTS.md).
