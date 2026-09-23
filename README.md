# ConTeXt SyncTeX (VS Code)

Companion VS Code extension for ConTeXt: compile with SyncTeX, preview PDF with PDF.js, and jump between source and PDF. Not a fork of the stock LMTX `mtx-vscode` syntax pack.

## Run locally (F5)

1. Install dependencies and compile:

```bash
npm install
npm run compile
```

2. Open this folder in VS Code / Cursor.
3. Press **F5** (launch config: **Run Extension**) to start an Extension Development Host.
4. In the new window, open a `.tex` / ConTeXt job and run **ConTeXt: Build and Preview** from the Command Palette.

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

Resolution order:

1. `context.contextPath` / `context.mtxrunPath` (absolute overrides, each independent)
2. Binaries under `context.root` (LMTX-style `bin` / `tex/texmf-*/bin` layout)
3. `context` and `mtxrun` on `PATH`

`context.root` defaults to **empty** (no hardcoded path). PATH installs need no config.

| Setting | Default | Notes |
| --- | --- | --- |
| `context.root` | `""` | LMTX root, e.g. `/home/andi/Apps/lmtx` |
| `context.contextPath` | `""` | Absolute `context` binary |
| `context.mtxrunPath` | `""` | Absolute `mtxrun` binary |
| `context.synctex.enabled` | `true` | Toggle SyncTeX |
| `context.build.args` | `[]` | Extra args after `--synctex=repeat` |

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
- Loads that **real job PDF** via `asWebviewUri` with the job directory (and workspace folders) in `localResourceRoots`
- Runs SyncTeX against the **real job `.synctex` / `.synctex.gz`** with `cwd=jobDir` (no globalStorage synctex copy on the happy path)
- If URI load 401s, falls back once to posting PDF bytes for that session
- Never mixes a new PDF with an old synctex mid-build (lookups use the last gated pair)

Build uses: `context --synctex=repeat` plus `context.build.args`.

## Local LMTX verification (e2e SyncTeX)

1. Set `"context.root": "/home/andi/Apps/lmtx"` (or PATH).
2. F5 → open a multi-file job → **Build and Preview**.
3. **Ctrl+click** the dedicatory / include region → should open `include/contenido/00-1-dedicatoria.tex` at line 2 (or the matching Input).
4. Confirm Output shows `--report --direct --console` and `file=… line=…` (not “no match”).
5. Confirm forward (`Ctrl+Alt+J`) and that a long/failed build does not replace the last good view.

## Layout

```
src/extension.ts
src/toolchain/discover.ts
src/build/compiler.ts
src/build/artifactGate.ts
src/synctex/mtxSynctex.ts
src/viewer/pdfPanel.ts
media/viewer/
```

Phase 2 (not in this MVP): Digestif LSP, tree-sitter-context.
