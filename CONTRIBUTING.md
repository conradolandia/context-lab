# Contributing to ConTeXt Tools

Developer workflow for this VS Code extension. End-user install and settings live in [`README.md`](README.md). Agent/architecture invariants live in [`AGENTS.md`](AGENTS.md).

## Clone and remotes

```bash
git clone <repo-url>
cd context-lab   # or your local checkout name
npm install
```

If you work through Cursor Cloud / Origin and also push to the public GitHub repo, keep the remotes distinct:

| Remote | Typical role |
| --- | --- |
| `origin` | Cursor / Origin forge (default push for cloud agents) |
| `upstream` | Public GitHub (`https://github.com/conradolandia/context-lab.git`) |

Adjust names to match your clone. Do not hardcode personal machine paths in docs, settings examples, or commits.

## Build, lint, test

```bash
npm install
npm run compile          # esbuild → dist/
npm run lint             # tsc --noEmit
npm test                 # compile + unit tests + grammar tests
npm run test:grammar     # TextMate fixtures only
npm run watch            # rebuild on change
```

Unit and grammar tests do not require a ConTeXt install. Optional DigestiF handshake (needs DigestiF + LMTX):

```bash
CONTEXT_ROOT=$HOME/context npm run handshake:context
# or: LMTX_ROOT=$HOME/context npm run handshake:context
```

## Extension Development Host (F5)

1. Open this folder in VS Code or Cursor.
2. `npm install && npm run compile` (or rely on the preLaunch task).
3. Press **F5** (launch config **Run Extension**). `.vscode/launch.json` runs `npm run compile` via `preLaunchTask` before each launch.

Use a throwaway workspace with ConTeXt sources to exercise build, SyncTeX, DigestiF, and the Project view. DigestiF start failure must not block Build and Preview.

## Package a VSIX

```bash
npm run compile
npx @vscode/vsce package
```

`package.json` `repository` / `publisher` fields must be valid for vsce. Output is a `.vsix` in the repo root (gitignored if configured; do not commit binaries).

## Refresh command keywords from LMTX

After upgrading LMTX, regenerate the committed SciTE keyword snapshot:

```bash
CONTEXT_ROOT=$HOME/context npm run generate:keywords
```

Or run **ConTeXt: Refresh command keywords** in the editor and reload the window. Provenance (hashes, date, optional LMTX version) is written into `syntaxes/context-keywords.json`. See [`NOTICE`](NOTICE).

Commit both `syntaxes/context-keywords.json` and any regenerated inlined rules in `syntaxes/context.tmLanguage.json` when the generator updates them.

After an intentional grammar change, regenerate the snapshot with:

```bash
npx vscode-tmgrammar-snap -u \
  -g src/test/grammar/stubs/lua.tmLanguage.json \
  -g src/test/grammar/stubs/xml.tmLanguage.json \
  "src/test/grammar/snap/*.mkiv"
```

Review the `.snap` diff before committing.

## Pull requests

- Target `main`.
- Keep scope focused; one concern per PR when practical.
- Run `npm run lint` and `npm test` before requesting review.
- Do not add personal absolute paths (`/home/alice/…`), machine hostnames, or private book/project paths in docs, fixtures you invent, or settings examples. For concrete installs use `$HOME/context` or `/opt/context`; `$CONTEXT_ROOT` is fine for shell env; temp dirs in tests.
- Do not claim `*.tex` globally in `package.json` contributes; DigestiF ConTeXt mode requires language id `context`.
- Soft-warn only for LaTeX Workshop conflicts; never auto-disable Workshop without the user action.
- License: GPL-2.0-only. Keep keyword provenance in [`NOTICE`](NOTICE) accurate when regenerating snapshots.
