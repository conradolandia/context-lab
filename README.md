# ConTeXt Tools (VS Code)

VS Code extension for ConTeXt: SyncTeX PDF preview, DigestiF language server, and TextMate grammar. Not a fork of the stock LMTX `mtx-vscode` syntax pack.

## Run locally (F5)

Checkout the PR branch and rebuild before launching so the Extension Host cannot load a stale `dist/`:

```bash
git fetch origin
git checkout cursor/rename-context-tools-120e
git pull origin cursor/rename-context-tools-120e
npm install
npm run compile
```

Then open this folder in VS Code / Cursor and press **F5** (launch config **Run Extension**). `preLaunchTask` runs `npm run compile` again on every F5.

After the Extension Development Host starts, open the **ConTeXt** output channel. You should see:

```text
ConTeXt Tools activated  version=0.1.19  BUILD_ID=context-tools-rename-v1
…
[digestif] BUILD_ID=context-tools-rename-v1 source=luarocks   (or override / path)
[digestif] launch method=direct — …
```

Or, on DigestiF failure (build still works immediately):

```text
[digestif] BUILD_ID=context-tools-rename-v1 failed to start: …
[digestif] BUILD_ID=context-tools-rename-v1 giving up for this window: …
```

Every **Build and Preview** reprints `BUILD_ID=…` (Output clear wipes earlier lines). DigestiF starts fire-and-forget and **never** blocks, delays, or is awaited by build/preview/SyncTeX. After one DigestiF failure it stays off until you change `context.digestif*` or reload the window.

Unit tests (no ConTeXt required):

```bash
npm test
```

## Commands and SyncTeX shortcuts

| Action | Command / binding |
| --- | --- |
| Build then open/refresh viewer | **ConTeXt: Build and Preview** |
| Show last gated PDF | **ConTeXt: Show PDF** |
| Forward SyncTeX (source → PDF) | **ConTeXt: Forward SyncTeX** — `Ctrl+Alt+J` (macOS: `Cmd+Alt+J`) |
| Backward SyncTeX (PDF → source) | **Ctrl+click** (macOS: **Cmd+click**) in the PDF webview |

CLI (project synctex, `cwd` = job directory):

- Forward: `mtxrun --script synctex --find --direct --file=… --line=… <job.synctex>`
- Backward: `mtxrun --script synctex --report --direct --console --page=… --x=… --y=… <job.synctex>`

The extension opens the resolved source itself (no `--editor`). Output channel logs exact `cwd` and `argv`. Parser accepts quoted values such as `filename='include/…/file.tex' linenumber='2'`.

## Toolchain settings

`context.root` is the **LMTX / ConTeXt Standalone install root**: the directory that contains `tex/`, **not** the `bin` folder. See [wiki Structure](https://wiki.contextgarden.net/ConTeXt_Standalone/Structure).

Sir’s layout:

```text
/home/andi/Apps/lmtx/                          ← set context.root here
  tex/
    texmf-linux-64/bin/context, mtxrun         ← binaries only
    texmf-context/tex/context/interface/mkiv/context-en.xml
```

Resolution order:

1. `context.contextPath` / `context.mtxrunPath` (absolute overrides, each independent)
2. Binaries under `context.root` → `{root}/tex/texmf-*/bin/{context,mtxrun}` (and older `bin/` layouts)
3. `context` and `mtxrun` on `PATH` (install root inferred by walking parents until `tex/texmf-context` exists)

`context.root` defaults to **empty** (no hardcoded path). PATH installs need no config when the binary realpath sits under a normal LMTX tree.

| Setting | Default | Notes |
| --- | --- | --- |
| `context.root` | `""` | Install root (parent of `tex/`), e.g. `/home/andi/Apps/lmtx` — never `…/bin` |
| `context.contextPath` | `""` | Absolute `context` binary |
| `context.mtxrunPath` | `""` | Absolute `mtxrun` binary |
| `context.synctex.enabled` | `true` | Toggle SyncTeX |
| `context.build.args` | `[]` | Extra args after `--synctex=repeat` |
| `context.build.onSave` | `false` | Save of a ConTeXt/TeX file starts a build; rapid saves coalesce to one follow-up |
| `context.rootFile` | `""` | Main file to compile (workspace-relative or absolute). Empty = auto-detect |
| `context.digestif.enabled` | `true` | Start Digestif LSP (completion / hover). Safe to leave on if Digestif is missing |
| `context.digestifPath` | `""` | Absolute Digestif binary; empty = `digestif` on PATH |

### Digestif LSP (completion / hover / outline)

Optional. DigestiF never blocks build or SyncTeX. DigestiF logs go to the **ConTeXt DigestiF** output channel; build logs stay on **ConTeXt**.

Document outline (DocumentSymbol) comes from DigestiF. This client runs a thin `middleware.provideDocumentSymbols` that only normalizes symbol names for display: strip wrapping `{}`, collapse whitespace/newlines to a single space, trim. Other DigestiF features are unchanged.

This extension contributes the **`context`** language (aliases: ConTeXt) for `.mkiv`, `.mkxl`, `.mkvi`, `.mklx`, `.mkii`. It does **not** claim `*.tex` globally. DigestiF maps LSP `languageId`:

| languageId | DigestiF format |
| --- | --- |
| `context` | ConTeXt (`context-en.xml` via `DIGESTIF_TEXMF`) |
| `tex` | LaTeX |
| `latex` | LaTeX |

So a `.tex` file left as Plain Text / TeX gets LaTeX tags. Use ConTeXt language mode for ConTeXt docs.

**Associate `*.tex` → ConTeXt (workspace)**

On Build / Show PDF of a `.tex` file whose language is not `context`, the extension offers once per workspace to set:

```json
"files.associations": {
  "*.tex": "context"
}
```

Choose **Don't ask again** (or set `context.texAssociation.dontAsk`) to suppress the prompt. You can also set the association by hand in workspace settings.

**Recommended (LuaRocks)** — DigestiF needs `lpeg`/`lfs`:

```bash
luarocks --local --lua-version 5.4 install digestif LUA_INCDIR=/usr/include/lua5.4
# Ensure ~/.luarocks/bin is on PATH, or set context.digestifPath
```

The luarocks package includes `ManuscriptConTeXt`; ConTeXt command data comes from generating tags from `context-en.xml` under `DIGESTIF_TEXMF` (set from `context.root`).

**Launch order:** `context.digestifPath` → `~/.luarocks/bin/digestif` → `digestif` on PATH.

**Verify**

1. F5 → `BUILD_ID=digestif-lsp-v9`.
2. Open a `.mkiv` (language ConTeXt) or associate `*.tex` → ConTeXt.
3. DigestiF channel: `source=luarocks`, then hover `\starttext` / complete `\setup` with ConTeXt docs (not only `latex.tags`).
4. Scripted check: `LMTX_ROOT=… npm run handshake:context`.

### Main (root) file resolution

Order (first match wins):

1. Setting `context.rootFile`
2. Magic comment in the first ~20 lines of the active file: `% !TEX root = <path>` (relative to that file)
3. ConTeXt structure: if the active file is a `\startcomponent`, find `\product <name>` and resolve `<name>.tex` nearby / in the workspace (compile the product even if it has `\project`)
4. Fallback: the active file

The status bar shows `ConTeXt: <rootname>`; click it to set or clear `context.rootFile` for the workspace. Build / Show PDF use the resolved root’s PDF and synctex; Forward SyncTeX still passes the **active** file+line to `--file`.

## Syntax highlighting and folding

`syntaxes/context.tmLanguage.json` is a hand-written TextMate grammar (scope `text.tex.context`) for the `context` language. It uses standard scope names, so ordinary themes color it; it does not use the `context.*` scopes of the stock `mtx-vscode` grammar.

| Construct | Scope |
| --- | --- |
| `% comment` (not `\%`) | `comment.line.percentage.context` |
| `\start…` / `\stop…` | `keyword.control.start.context` / `keyword.control.stop.context` |
| Other control sequences (`\[a-zA-Z]+`) | `support.function.context` |
| `\%`, `\$`, `\{`, `\\`, `\,` … | `constant.character.escape.context` |
| `#1` … `#9`, `##1` | `variable.parameter.context` |
| `[...]` | `meta.options.context` |
| `key=value` inside `[...]` | `entity.other.attribute-name.context`, value text `string.unquoted.value.context` |
| `{...}` | `meta.group.braces.context` |
| `$…$`, `\m{}`, `\math{}`, `\mathematics{}` | `meta.math.inline.context`, body `support.class.math.context` |
| `$$…$$`, `\startformula … \stopformula` | `meta.math.display.context`, body `support.class.math.context` |
| `\type{}`, `\type<<…>>`, `\type\|…\|`, `\typ` | `markup.inline.raw.context` |
| `\starttyping`, `\startTEX`, `\startMP`, `\startHTML`, `\startCSS` | body `markup.raw.block.context` |
| `\startluacode`, `\startluasetups`, `\startlua`, `\startLUA`, `\startctxfunction`, `\startctxfunctiondefinition` | body `meta.embedded.block.lua` (built-in `source.lua`) |
| `\ctxlua{}`, `\directlua{}`, `\luaexpr{}`, `\ctxcommand{}`, `\latelua{}` | body `meta.embedded.inline.lua` (built-in `source.lua`) |
| `\startXML`, `\startPARSEDXML` | body `meta.embedded.block.xml` (built-in `text.xml`) |
| `\start…MP…` (`\startMPcode`, `\startuseMPgraphic`, `\startMPpage`, …) | body `meta.embedded.block.metapost`, not highlighted |

Notes:

- Lua and XML bodies map to the `lua` and `xml` languages (`embeddedLanguages`), so comment toggling uses `--` and `<!-- -->` there.
- Value text in `key=value` has token type `other` (`tokenTypes`), not `string`, so the default `editor.quickSuggestions` setting (off in strings) does not suppress completion there.
- Brackets inside verbatim bodies are excluded from bracket matching and colorization (`unbalancedBracketScopes`).
- `\startxmlsetups` and `\startbuffer` bodies are highlighted as TeX: setups contain TeX, and buffer contents are not known in advance.
- English interface only. Command names use ASCII letters; `\unprotect` names with `_`, `!` or `?` split at those characters. Environments defined with `\definetyping` are not recognized as verbatim.
- A `[` in running text also opens an options region until the next `]`.

**Folding.** This extension registers a folding range provider that stacks `\start<name>` / `\stop<name>` and matches names. A name mismatch (for example `\startsection` … `\stopsubsection`) is reported as a warning diagnostic (`context.folding`). Bodies of common typing / Lua / MetaPost regions are skipped. While the provider is active it replaces TextMate folding markers in `language-configuration.json`; those markers remain as a fallback when the provider is not registered. `%region` / `%endregion` markers are still available via language configuration when no provider applies.

Limitations of the marker fallback (when the provider is off):

- Start and stop names are not matched. The markers pair like a stack, so `\startsection … \stopsubsection` folds as one region.
- Markers only count at the start of a line. A line that contains both `\start<name>` and `\stop<name>` (for example `\startitemize \item a \stopitemize`) is ignored.
- Lines inside `\starttyping` or `\startluacode` that begin with `\start…` or `\stop…` also count as markers.

## Build diagnostics

After each build, stdout, stderr, and the job `.log` (when present) are parsed into the Problems panel (`context.build`). Previous build diagnostics are cleared at the start of the next build.

Patterns (LMTX console / log):

| Pattern | Severity |
| --- | --- |
| `tex error > tex error on line N in file PATH: …` | error |
| `error (input): file {NAME} is not found` | error |
| `modules > 'NAME' is not found` | error |
| `pack quality > overfull … at line N in file …` | warning |
| `pack quality > loose … at line N in file …` (LMTX underfull) | warning |

Fixtures under `src/test/fixtures/diagnostics/` were captured from deliberate LMTX compiles (undefined csname, missing input, overfull/loose boxes, missing module) plus a clean compile that must produce zero errors.

## Document links

Ctrl/Cmd-click resolves file names in `\component`, `\product`, `\environment`, `\project`, `\input`, `\usemodule`, and `\externalfigure` (space, `[]`, and `{}` argument forms). `\usepath[...]` directories relative to the declaring file are searched. Path resolution lives in `src/project/pathResolve.ts` / `structureScan.ts` for reuse by a later project TreeView. Hover on `\externalfigure` shows an image preview for common raster/SVG paths when the file resolves; the preview is scaled to fit a small tooltip box (max 360×280, aspect ratio kept).

## Build on save

`context.build.onSave` (default `false`) starts a build when a ConTeXt/TeX document is saved. While a build runs, further saves queue **one** follow-up build (rapid saves coalesce); the command path still shows “already running” if you invoke Build and Preview during a build. A status bar item shows build state and the last duration.

**LaTeX Workshop conflict.** LaTeX Workshop 10.19.0 also contributes language id `context` (for `.ctx`) and maps it to its LaTeX grammar `text.tex.latex`. VS Code keeps one grammar per language id, and the last one registered wins. Tested with `_workbench.captureSyntaxTokens`:

| VS Code | Installed | Grammar used for `.mkiv` |
| --- | --- | --- |
| 1.139.1 | this extension only | `text.tex.context` |
| 1.139.1 | this extension + LaTeX Workshop 10.19.0 (either install order) | `text.tex.latex` |
| 1.139.1 | same, LaTeX Workshop disabled | `text.tex.context` |
| 1.85.2 | this extension + LaTeX Workshop 9.20.1 (newest for 1.85) | `text.tex.context` (9.20.1 has no `context` language) |

With both extensions installed, disable LaTeX Workshop for ConTeXt workspaces (**Extensions → LaTeX Workshop → Disable (Workspace)**). When this extension runs from F5 (Extension Development Host), its grammar is registered last and wins, so F5 sessions do not show the conflict.

**Tests.** `npm test` runs the grammar tests (`npm run test:grammar`) after the unit tests. Assertion fixtures (`vscode-tmgrammar-test`) are `src/test/grammar/*.test.mkiv`; a snapshot of a sample document is in `src/test/grammar/snap/`. `src/test/grammar/stubs/` has minimal `source.lua` and `text.xml` grammars that use the scope names of the VS Code built-in grammars. After an intended grammar change, regenerate the snapshot with `npx vscode-tmgrammar-snap -u -g src/test/grammar/stubs/lua.tmLanguage.json -g src/test/grammar/stubs/xml.tmLanguage.json "src/test/grammar/snap/*.mkiv"` and review the diff.

## SyncTeX coordinates

mtxrun `--script synctex` exchanges **y top-down** (origin at the page top). The viewer converts PDF.js bottom-up click y with `pageHeight - pdfY` before `--report`, and maps forward `lly`/`ury` as top-down when highlighting.

**Images / pure graphics.** ConTeXt SyncTeX **only marks text** (Hans: “we only mark text and don't bother about the rest”). Figure image areas have **no** SyncTeX record, so `mtxrun --script synctex --report …` exits 0 with empty stdout. The extension shows a short toast in that case and may retry once with a larger `--tolerance`, then a local nearest-box parse of the `.synctex` page. It does not invent a source line for an image-only click.

**Captions / floats.** Caption clicks often *do* hit a text box, but ConTeXt may tag most of that text with a coarse line (commonly line 1 of the file). Experiments on LMTX 2026.09.22 (`method=min` vs `max`, `state=start` vs `repeat`) show the same line-1 tagging for caption body; `method` only changes box granularity (words vs ranges) and runtime (~10% vs ~5%), not caption line accuracy. CLI `--synctex` / `--synctex=repeat` always selects `method=max`; `method` is only settable via `\setupsynctex`. When `--report` returns line ≤ 1 for a mid-page click and no nearer higher-line box exists, the extension **does not jump** — it shows an info toast distinct from the empty-image warning. Click nearby body text for a useful match.


Example (Sir’s machine):

```json
{
  "context.root": "/home/andi/Apps/lmtx"
}
```

## Compile-safe PDF viewer

ConTeXt often rewrites the job PDF for several seconds. This extension:

- Keeps the **last good** view while a build runs (status: Building…); does not reload mid-compile
- Does **not** `fs.watch` the live job PDF into the viewer
- After exit code 0, runs a **stability gate** (size settle, `%PDF-` header) on the **job** PDF next to the document
- Loads that **real job PDF** via a loopback **range server** (`Accept-Ranges` + CORS) so PDF.js can request page-1 chunks; falls back to `asWebviewUri`, then bytes on 401
- Runs PDF.js parsing in a **real dedicated worker** built from a `blob:` URL (VS Code webview `workerSrc` URLs are cross-origin and fall back to a fake/main-thread worker)
- Runs SyncTeX against the **real job `.synctex` / `.synctex.gz`** with `cwd=jobDir` (no globalStorage synctex copy on the happy path)
- If URI load 401s, falls back once to posting PDF bytes for that session
- Never mixes a new PDF with an old synctex mid-build (lookups use the last gated pair)

Build uses: `context --synctex=repeat` plus `context.build.args`.

## Local LMTX verification (e2e SyncTeX)

1. Set `"context.root": "/home/andi/Apps/lmtx"` (or PATH).
2. F5 → open a multi-file job → **Build and Preview**.
3. **Ctrl+click** the dedicatory / include region → should open `include/contenido/00-1-dedicatoria.tex` at line 2.
4. Confirm Output shows `file=include/contenido/00-1-dedicatoria.tex line=2` (not “no match”), plus `--report --direct --console`.
5. **Ctrl+click an image / figure region** in the PDF: toast should say there is no SyncTeX data at that point (common for images). Output still logs the empty mtxrun argv. Click near text on the same page — jump should still work. SyncTeX does not invent a source line for image-only hits.
6. **Ctrl+click a figure caption**: if the engine only tagged line 1 mid-page, Output shows `coarseFloatLine=1` and an info toast — **no jump to file start**. Click nearby body text for a precise jump.
7. **Ctrl+Alt+J** / Ctrl+click on a long page (e.g. prologue page 12) — highlight and jumps should track the correct vertical position.
8. Status bar shows the main file; click to change `context.rootFile`.
9. On a large PDF (`BUILD_ID=viewer-worker-v1`): Output should show `worker=real`, `rangeServer=http://127.0.0.1:…`, `rangeReqs` > 0, and `getDocumentMs` / `firstPageMs` in the low thousands (target: first page ~1–2 s on a ~70 MB / 360-page job). If you see `worker=fake`, the blob worker failed — report that line.
10. Confirm a long/failed build does not replace the last good view.

## Layout

```
src/extension.ts
src/toolchain/discover.ts
src/lsp/digestifEnv.ts
src/lsp/digestifClient.ts
src/lsp/digestifLaunch.ts
src/build/compiler.ts
src/build/buildController.ts
src/build/parseLog.ts
src/build/buildDiagnostics.ts
src/build/artifactGate.ts
src/project/pathResolve.ts
src/project/structureScan.ts
src/project/verbatimRegions.ts
src/links/documentLinks.ts
src/folding/startStopFolding.ts
src/synctex/mtxSynctex.ts
src/synctex/synctexBoxes.ts
src/synctex/coords.ts
src/viewer/pdfPanel.ts
media/viewer/
syntaxes/context.tmLanguage.json
src/test/grammar/
src/test/fixtures/diagnostics/
```

Stacked on the TextMate grammar branch (`cursor/textmate-baseline-grammar-64f0` / PR #5). Tree-sitter remains on hold; project TreeView is a separate plan that reuses `pathResolve` / `structureScan`.
