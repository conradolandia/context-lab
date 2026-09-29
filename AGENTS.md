# Agent guidance (ConTeXt Tools)

Instructions for coding agents and LLMs working in this repository. Setup commands: [`CONTRIBUTING.md`](CONTRIBUTING.md). User-facing docs: [`README.md`](README.md).

## Architecture map

```text
src/extension.ts              Activation, commands, wiring
src/toolchain/                Discover context/mtxrun from context.root / PATH
src/build/                    Spawn build, queue, log parse, diagnostics, PDF gate
src/viewer/                   PDF webview panel, range server, PDF.js worker
src/synctex/                  mtxrun synctex CLI, box parse, coordinate mapping
src/lsp/                      DigestiF launch, client, env (DIGESTIF_TEXMF)
src/project/                  Root file, structure scan, path resolve, Project TreeView
src/links/                    Document links + figure hover
src/folding/                  \start…/\stop… folding + mismatch diagnostics
src/syntax/                   Refresh keywords command
src/compat/                   LaTeX Workshop language-id conflict soft-warn
media/viewer/                 Webview HTML/JS/CSS (PDF.js)
syntaxes/                     TextMate grammar + keyword snapshot
scripts/                      generate-context-keywords, digestif handshake
```

Build path: `buildController` → `spawnContextBuild` → artifact gate → viewer reload. SyncTeX uses the last gated PDF + `.synctex` pair. DigestiF starts fire-and-forget on activate; build never awaits it.

## Invariants (do not break)

1. **stdin ignore on `context` spawn.** Always `stdio: ['ignore', 'pipe', 'pipe']` (see `src/build/spawnContext.ts`). An open stdin pipe can hang LuaMetaTeX and leave the extension stuck in “building”.
2. **DigestiF must not block build.** Launch is async; failures log to the DigestiF channel and give up for the window until settings change or reload. Build / preview / SyncTeX proceed regardless.
3. **Language id `context` for DigestiF ConTeXt mode.** DigestiF maps `tex`/`latex` → LaTeX tags. ConTeXt completion needs `languageId === 'context'`.
4. **Do not claim `*.tex` globally** in `contributes.languages`. Offer workspace `files.associations` via the existing prompt / setting only.
5. **LaTeX Workshop conflict: soft-warn only.** Detect when Workshop contributes language id `context`; warn once with disable / unwantedRecommendations / dismiss. Never auto-disable without the user’s chosen action. Skip the modal in `ExtensionMode.Development` (F5 grammar usually wins).
6. **No user PII in docs or examples.** Prefer `$CONTEXT_ROOT`, `/path/to/context`, or OS temp dirs. Do not commit personal home paths, hostnames, or private manuscript paths.
7. **GPL-2.0-only.** Keyword regeneration redistributes SciTE-derived names; keep [`NOTICE`](NOTICE) accurate.

## Tests and checks

```bash
npm run lint
npm test
npm run test:grammar
```

Relevant unit areas: `src/test/buildDigestifIsolation.test.ts` (stdin / DigestiF isolation), `latexWorkshopConflict`, `digestif*`, `mtxSynctex`, `projectModel`, `parseLog`, grammar fixtures under `src/test/grammar/`.

Optional (needs local toolchain): `CONTEXT_ROOT=… npm run handshake:context`.

## Plans and out-of-repo notes

There is **no** in-repo `plans/` or design-doc tree. Longer design notes (tree-sitter, feature handoffs) may live in the Cursor Project store (`docs/`) outside git; treat them as historical unless the task links them. Do not invent a parallel plan tree in the repo without an explicit request.

## Do-not-touch / caution

| Area | Caution |
| --- | --- |
| `src/build/spawnContext.ts` stdio | Keep stdin `'ignore'` |
| DigestiF lifecycle vs build queue | No await of DigestiF from build/preview/SyncTeX |
| `package.json` languages / grammars | Language id stays `context`; no global `*.tex` |
| `src/compat/latexWorkshopConflict*` | Soft-warn policy only |
| `syntaxes/context-keywords.json` | Regenerate via `npm run generate:keywords`, do not hand-edit huge lists |
| `media/viewer/` PDF.js worker / range server | Easy to regress large-PDF first-page latency |
| Vendor / lockfile | Prefer existing deps; no second component library |

Tree-sitter remains on hold; TextMate is the shipped highlighter. Prefer minimal diffs that match existing TypeScript style in `src/`.
