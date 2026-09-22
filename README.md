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
| Show last gated PDF snapshot | **ConTeXt: Show PDF** |
| Forward SyncTeX (source → PDF) | **ConTeXt: Forward SyncTeX** — `Ctrl+Alt+J` (macOS: `Cmd+Alt+J`) |
| Backward SyncTeX (PDF → source) | **Ctrl+click** (macOS: **Cmd+click**) in the PDF webview |

Forward/backward call `mtxrun --script synctex --find` / `--report` against a **frozen** `.synctex` snapshot paired with the shown PDF.

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

If a binary is missing, the extension reports a clear error pointing at `context.root` and PATH setup.

## Compile-safe PDF viewer

ConTeXt often rewrites the job PDF for several seconds. Loading that file mid-write crashes PDF.js. This extension:

- Keeps the **last good** cached view while a build runs (status: Building…)
- Does **not** `fs.watch` the live job PDF into the viewer
- After exit code 0, runs a **stability gate** (non-zero size settle, `%PDF-` header) then copies PDF + synctex into an extension cache
- Points PDF.js only at that **cache snapshot**
- On webview load failure, restores the **previous** snapshot when available
- Never mixes a new PDF with an old synctex (or the reverse)

Build uses: `context --synctex=repeat` plus `context.build.args`.

## Local LMTX verification (e2e SyncTeX)

Cloud / CI covers scaffolding, compile, and unit tests for gate + SyncTeX CLI parsing. End-to-end click ↔ source accuracy needs a real LMTX install:

1. Set `"context.root": "/home/andi/Apps/lmtx"` (or ensure `context` / `mtxrun` are on PATH).
2. F5 → open a ConTeXt job → **Build and Preview**.
3. Confirm forward (`Ctrl+Alt+J`) scrolls/highlights the PDF and Ctrl+click jumps to the source line.
4. Confirm a long compile keeps the previous PDF visible and a failed build does not replace it.

Candidate host when that path is available: connected machine `furiosa`.

## Layout

```
src/extension.ts
src/toolchain/discover.ts
src/build/compiler.ts
src/build/artifactGate.ts
src/synctex/mtxSynctex.ts
src/viewer/pdfPanel.ts
media/viewer/          # PDF.js page + assets
```

Phase 2 (not in this MVP): Digestif LSP, tree-sitter-context.
