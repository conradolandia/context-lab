# ConTeXt SyncTeX (VS Code)

Companion VS Code extension for ConTeXt: compile with SyncTeX, preview PDF with PDF.js, and jump between source and PDF. Not a fork of the stock LMTX `mtx-vscode` syntax pack.

## Run locally (F5)

Checkout the PR branch and rebuild before launching so the Extension Host cannot load a stale `dist/`:

```bash
git fetch origin
git checkout cursor/digestif-lsp-bc94
git pull origin cursor/digestif-lsp-bc94
npm install
npm run compile
```

Then open this folder in VS Code / Cursor and press **F5** (launch config **Run Extension**). `preLaunchTask` runs `npm run compile` again on every F5.

After the Extension Development Host starts, open the **ConTeXt** output channel. You should see:

```text
ConTeXt SyncTeX activated  version=0.1.11  BUILD_ID=digestif-lsp-v5
[digestif] root=/home/andi/Apps/lmtx  …
[digestif] launch method=luametatex-luaonly — self-install wrapper → luametatex --luaonly …/.digestif/bin/digestif
[digestif] spawned pid=… (stdio LSP — silence until initialize is normal)
[digestif] language client started
```

DigestiF is an LSP server on stdio: running `luametatex --luaonly ~/.digestif/bin/digestif` by hand prints nothing and waits — that is **normal** (it waits for LSP `initialize` on stdin). Do not treat silence as a hang. If startup fails, look for **`[digestif] --- last stderr ---`**. Build and SyncTeX still work. Running Extensions should show **0 uncaught errors**.

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
| `context.rootFile` | `""` | Main file to compile (workspace-relative or absolute). Empty = auto-detect |
| `context.digestif.enabled` | `true` | Start Digestif LSP (completion / hover). Safe to leave on if Digestif is missing |
| `context.digestifPath` | `""` | Absolute Digestif binary; empty = `digestif` on PATH |

### Digestif LSP (completion / hover)

This extension starts [Digestif](https://github.com/astoff/digestif) over stdio when `context.digestif.enabled` is true. TexLab is not used. Digestif is **not** vendored; install it yourself.

**Install DigestiF** (pick one):

1. **Self-install wrapper** (expects a LuaTeX-compatible `texlua`):
   - Download [digestif](https://raw.githubusercontent.com/astoff/digestif/master/scripts/digestif) into `~/.local/bin`, `chmod +x`.
   - First run clones into `~/.digestif`.
   - Under **LMTX**, TeX Live `texlua` is usually missing. This extension launches DigestiF as:
     `luametatex --luaonly ~/.digestif/bin/digestif`
     (and installs a `texlua` shim that runs `luametatex --luaonly`, not a bare symlink).
2. **LuaRocks** (often easier with a system Lua): `luarocks install --local digestif`, put `~/.luarocks/bin` on `PATH`, or set `context.digestifPath` to that script.

**LMTX / interface XML**

```json
{
  "context.root": "/home/andi/Apps/lmtx"
}
```

Derived paths (never under `bin/`):

- XML: `/home/andi/Apps/lmtx/tex/texmf-context/tex/context/interface/mkiv/context-en.xml`
- `DIGESTIF_TEXMF`: `/home/andi/Apps/lmtx/tex/texmf-context`
- Launch (typical): `…/tex/texmf-linux-64/bin/luametatex --luaonly ~/.digestif/bin/digestif`

**Verify completion / hover**

1. Install DigestiF (wrapper or luarocks).
2. Set `context.root` to `/home/andi/Apps/lmtx`.
3. Disable Marketplace **DigestiF** in the Extension Development Host while testing.
4. F5 → Output: `BUILD_ID=digestif-lsp-v5`, `launch method=luametatex-luaonly` (or `direct` for luarocks), then **`[digestif] language client started`**.
5. Open a ConTeXt buffer → try completion (`\setup` + Ctrl+Space) and hover on `\starttext`.
6. If it fails: find **`[digestif] --- last stderr ---`**. Silence when DigestiF is run by hand is normal (LSP waits on stdin). A 30s initialize timeout means DigestiF never answered LSP — check stderr, Marketplace DigestiF conflict, or `DIGESTIF_TEXMF`.

**Marketplace DigestiF conflict**

Disable Marketplace **DigestiF** (`phil.red` / similar) while testing. Our client id is `contextSyncTeX.digestif` / **ConTeXt SyncTeX Digestif**.

**Troubleshooting**

| Symptom | What to check |
| --- | --- |
| Hand-run DigestiF prints nothing and waits | **Normal** — it is an LSP server waiting for stdin |
| `process exited code=1` + stream destroyed | Scroll to `[digestif] --- last stderr ---` |
| Initialize timed out after 30s | DigestiF never completed LSP handshake; check stderr / Marketplace conflict / XML env |
| Wrapper without `luametatex-luaonly` in Output | Update to v4+; bare texlua→luametatex symlink is wrong |
| `could not find data files` | DigestiF home incomplete; re-run wrapper once, or set `DIGESTIF_DATA` |
| XML under `/bin/tex/` | Wrong root; set install root (parent of `tex/`) |
| Two DigestiF servers fighting | Disable Marketplace DigestiF |

DigestiF maps LSP language id `context` to ConTeXt and `tex` to LaTeX. Prefer the **context** language mode for ConTeXt sources when a grammar extension provides it.

### Main (root) file resolution

Order (first match wins):

1. Setting `context.rootFile`
2. Magic comment in the first ~20 lines of the active file: `% !TEX root = <path>` (relative to that file)
3. ConTeXt structure: if the active file is a `\startcomponent`, find `\product <name>` and resolve `<name>.tex` nearby / in the workspace (compile the product even if it has `\project`)
4. Fallback: the active file

The status bar shows `ConTeXt: <rootname>`; click it to set or clear `context.rootFile` for the workspace. Build / Show PDF use the resolved root’s PDF and synctex; Forward SyncTeX still passes the **active** file+line to `--file`.

## SyncTeX coordinates

mtxrun `--script synctex` exchanges **y top-down** (origin at the page top). The viewer converts PDF.js bottom-up click y with `pageHeight - pdfY` before `--report`, and maps forward `lly`/`ury` as top-down when highlighting.

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
5. **Ctrl+Alt+J** / Ctrl+click on a long page (e.g. prologue page 12) — highlight and jumps should track the correct vertical position.
6. Status bar shows the main file; click to change `context.rootFile`.
7. On a large PDF (`BUILD_ID=viewer-worker-v1`): Output should show `worker=real`, `rangeServer=http://127.0.0.1:…`, `rangeReqs` > 0, and `getDocumentMs` / `firstPageMs` in the low thousands (target: first page ~1–2 s on a ~70 MB / 360-page job). If you see `worker=fake`, the blob worker failed — report that line.
8. Confirm a long/failed build does not replace the last good view.

## Layout

```
src/extension.ts
src/toolchain/discover.ts
src/lsp/digestifEnv.ts
src/lsp/digestifClient.ts
src/build/compiler.ts
src/build/artifactGate.ts
src/synctex/mtxSynctex.ts
src/viewer/pdfPanel.ts
media/viewer/
```

Phase 2b (later): tree-sitter-context for folding/highlighting.
