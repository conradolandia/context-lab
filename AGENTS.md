# Agent guidance (ConTeXt Tools)

Coding-agent notes for this repo. Setup: [`CONTRIBUTING.md`](CONTRIBUTING.md). User docs: [`README.md`](README.md).

## Architecture map

```text
src/extension.ts              Activation, commands, wiring
src/toolchain/                Discover context/mtxrun from context.root / PATH
src/build/                    Spawn build, queue, log parse, diagnostics, PDF gate
src/viewer/                   PDF webview panel, range server, PDF.js worker
src/synctex/                  mtxrun synctex CLI, box parse, coordinate mapping
src/lsp/                      DigestiF launch, client, env (DIGESTIF_TEXMF)
src/project/                  Root file, structure scan, path resolve, Project TreeView
src/projectManager/           New Document Structure wizard
src/links/                    Document links + figure hover
src/folding/                  \start…/\stop… folding + mismatch diagnostics
src/syntax/                   Refresh keywords command
src/compat/                   LaTeX Workshop language-id conflict soft-warn
media/viewer/                 Webview HTML/JS/CSS (PDF.js)
syntaxes/                     TextMate grammar + keyword snapshot
scripts/                      generate-context-keywords, digestif handshake
```

Build path: `buildController` → `spawnContextBuild` → artifact gate → viewer reload. SyncTeX uses the last gated PDF + `.synctex` pair. DigestiF starts fire-and-forget on activate; build never awaits it.

## Invariants

1. **stdin ignore on `context` spawn.** Always `stdio: ['ignore', 'pipe', 'pipe']` (`src/build/spawnContext.ts`). An open stdin pipe can hang LuaMetaTeX.
2. **DigestiF must not block build.** Launch is async; failures log to the DigestiF channel. Build / preview / SyncTeX proceed regardless.
3. **Language id `context` for DigestiF ConTeXt mode.** DigestiF maps `tex`/`latex` → LaTeX tags.
4. **Do not claim `*.tex` globally** in `contributes.languages`. Offer workspace `files.associations` via the existing prompt only.
5. **LaTeX Workshop conflict: soft-warn only.** Never auto-disable without the user’s chosen action. Skip the modal in `ExtensionMode.Development`.
6. **No user PII in docs or examples.** Prefer `$CONTEXT_ROOT`, `$HOME/context`, `/opt/context`, or OS temp dirs.
7. **GPL-2.0-only.** Keep [`NOTICE`](NOTICE) accurate when regenerating keywords.

## Checks

```bash
npm run lint && npm test
```

Relevant unit areas: `buildDigestifIsolation`, `latexWorkshopConflict`, `digestif*`, `mtxSynctex`, `projectModel`, `parseLog`, grammar fixtures under `src/test/grammar/`. Optional: `CONTEXT_ROOT=… npm run handshake:context`.

## Caution

| Area | Caution |
| --- | --- |
| `src/build/spawnContext.ts` stdio | Keep stdin `'ignore'` |
| DigestiF vs build queue | No await of DigestiF from build/preview/SyncTeX |
| `package.json` languages / grammars | Language id `context`; no global `*.tex` |
| `src/compat/latexWorkshopConflict*` | Soft-warn policy only |
| `syntaxes/context-keywords.json` | Regenerate via `npm run generate:keywords` |
| `media/viewer/` | Easy to regress large-PDF first-page latency |

Tree-sitter remains on hold; TextMate is the shipped highlighter. Prefer minimal diffs that match existing TypeScript style in `src/`. There is no in-repo `plans/` tree; longer design notes may live in the Cursor Project store outside git.
