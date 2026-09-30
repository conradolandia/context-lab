# Contributing to ConTeXt Tools

Developer workflow. End-user install and settings: [`README.md`](README.md). Agent invariants: [`AGENTS.md`](AGENTS.md).

## Setup

```bash
git clone <repo-url>
cd context-lab   # or your local checkout name
npm install
```

If you push both to Cursor / Origin and to public GitHub, keep remotes distinct (`origin` vs `upstream`). Use `$HOME/context`, `/opt/context`, or `$CONTEXT_ROOT` in docs and examples — not personal machine paths.

## Build, lint, test

```bash
npm run compile          # esbuild → dist/
npm run lint             # tsc --noEmit
npm test                 # compile + unit + grammar tests
npm run test:grammar     # TextMate fixtures only
npm run watch            # rebuild on change
```

Unit and grammar tests do not need a ConTeXt install. Optional DigestiF handshake:

```bash
CONTEXT_ROOT=$HOME/context npm run handshake:context
```

## Extension Development Host (F5)

Open this folder → `npm install && npm run compile` → **F5** (**Run Extension**). DigestiF start failure must not block Build and Preview.

## Package a VSIX

```bash
npm run compile
npx @vscode/vsce package
```

Output is a `.vsix` in the repo root (do not commit it).

## Refresh command keywords

```bash
CONTEXT_ROOT=$HOME/context npm run generate:keywords
```

Or **ConTeXt: Refresh command keywords** in the editor, then reload. Commit `syntaxes/context-keywords.json` and any regenerated rules in `syntaxes/context.tmLanguage.json`. See [`NOTICE`](NOTICE).

After an intentional grammar change, update snapshots:

```bash
npx vscode-tmgrammar-snap -u \
  -g src/test/grammar/stubs/lua.tmLanguage.json \
  -g src/test/grammar/stubs/xml.tmLanguage.json \
  "src/test/grammar/snap/*.mkiv"
```

## Pull requests

- Target `main`; keep scope focused.
- Run `npm run lint` and `npm test` before review.
- Language id stays `context`; do not claim `*.tex` globally.
- LaTeX Workshop: soft-warn only.
- License: GPL-2.0-only; keep [`NOTICE`](NOTICE) accurate when regenerating keywords.
