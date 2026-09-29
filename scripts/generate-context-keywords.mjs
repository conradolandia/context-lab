#!/usr/bin/env node
/**
 * Generate ConTeXt command keyword lists from LMTX SciTE data tables and
 * wire them into syntaxes/context.tmLanguage.json.
 *
 * Data files (same inputs as mtxrun --script vscode):
 *   {root}/tex/texmf-context/context/data/scite/context/lexers/data/
 *     scite-context-data-context.lua
 *     scite-context-data-interfaces.lua
 *     scite-context-data-tex.lua
 *
 * Usage:
 *   CONTEXT_ROOT=/path/to/context npm run generate:keywords
 *   node scripts/generate-context-keywords.mjs --data-dir /path/to/lexers/data
 *   node scripts/generate-context-keywords.mjs --root /path/to/context
 *
 * Classification mirrors mtx-vscode.lua (common interface only; helpers and
 * constants overload primitives; normal* variants added for engine names).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const SCITE_DATA_REL = join(
  'tex',
  'texmf-context',
  'context',
  'data',
  'scite',
  'context',
  'lexers',
  'data',
);

const DATA_FILES = [
  'scite-context-data-context.lua',
  'scite-context-data-interfaces.lua',
  'scite-context-data-tex.lua',
];

const ENGINE_KEYS = ['tex', 'etex', 'pdftex', 'aleph', 'omega', 'luatex', 'xetex'];

/** Reverse-alpha sort, matching mtx-vscode.lua `sorter` (a > b). */
export function sortKeywords(list) {
  return [...list].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function which(binary) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [binary], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first && isExecutable(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

function isInstallRoot(dir) {
  if (!dir) return false;
  const base = dir.split(/[/\\]/).filter(Boolean).pop();
  if (base === 'bin') return false;
  const xml = join(
    dir,
    'tex',
    'texmf-context',
    'tex',
    'context',
    'interface',
    'mkiv',
    'context-en.xml',
  );
  if (existsSync(xml) && statSync(xml).isFile()) return true;
  const texmf = join(dir, 'tex', 'texmf-context');
  return existsSync(texmf) && statSync(texmf).isDirectory();
}

function walkToInstallRoot(start) {
  if (!start) return undefined;
  let dir;
  try {
    const resolved = realpathSync(start);
    dir =
      existsSync(resolved) && statSync(resolved).isFile()
        ? dirname(resolved)
        : resolved;
  } catch {
    dir =
      existsSync(start) && statSync(start).isFile() ? dirname(start) : start;
  }
  for (let i = 0; i < 12; i++) {
    if (isInstallRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolveInstallRoot(candidate) {
  const trimmed = candidate?.trim();
  if (!trimmed) return undefined;
  if (isInstallRoot(trimmed)) return resolve(trimmed);
  return walkToInstallRoot(trimmed);
}

function candidateBinDirs(root) {
  const platformHints = [
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'osx-arm64'
        : 'osx-64'
      : process.platform === 'win32'
        ? 'mswin'
        : process.arch === 'arm64'
          ? 'linux-aarch64'
          : 'linux-64',
    'linux-64',
    'linux-aarch64',
    'osx-64',
    'osx-arm64',
    'mswin',
  ];
  const dirs = [];
  const push = (p) => {
    if (!dirs.includes(p)) dirs.push(p);
  };
  for (const hint of platformHints) {
    push(join(root, 'tex', `texmf-${hint}`, 'bin'));
  }
  push(join(root, 'bin'));
  for (const hint of platformHints) {
    push(join(root, 'bin', hint));
  }
  push(root);
  return dirs;
}

function findBinaryUnderRoot(root, name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of candidateBinDirs(root)) {
    const candidate = join(dir, exe);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Minimal parser for SciTE data files shaped like:
 *   return { ["key"]={ "a", "b" }, ["other"]={ ["x"]="y", ... } }
 * Arrays of quoted strings and string→string maps are supported.
 */
export function parseLuaStringTables(source) {
  let i = 0;
  const s = source;
  const n = s.length;

  function skipWs() {
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
        i++;
        continue;
      }
      if (c === '-' && s[i + 1] === '-') {
        i += 2;
        while (i < n && s[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function readString() {
    if (s[i] !== '"') throw new Error(`Expected string at ${i}`);
    i++;
    let out = '';
    while (i < n) {
      const c = s[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        i++;
        if (i >= n) throw new Error('Unterminated escape');
        out += s[i++];
        continue;
      }
      out += c;
      i++;
    }
    throw new Error('Unterminated string');
  }

  function readKey() {
    skipWs();
    if (s[i] === '[') {
      i++;
      skipWs();
      const key = readString();
      skipWs();
      if (s[i] !== ']') throw new Error(`Expected ] after key at ${i}`);
      i++;
      return key;
    }
    throw new Error(`Expected [key] at ${i}`);
  }

  function readValue() {
    skipWs();
    if (s[i] === '"') return readString();
    if (s[i] === '{') return readTable();
    throw new Error(`Unexpected value at ${i}: ${s.slice(i, i + 20)}`);
  }

  function readTable() {
    skipWs();
    if (s[i] !== '{') throw new Error(`Expected { at ${i}`);
    i++;
    skipWs();
    // Decide array vs map by peeking
    const items = [];
    const map = Object.create(null);
    let isMap = null;

    while (i < n) {
      skipWs();
      if (s[i] === '}') {
        i++;
        break;
      }
      if (s[i] === '"') {
        if (isMap === true) {
          throw new Error(`Bare string in map table at ${i}`);
        }
        isMap = false;
        items.push(readString());
        skipWs();
        continue;
      }
      if (s[i] === '[') {
        if (isMap === false) {
          throw new Error(`Keyed entry in array table at ${i}`);
        }
        isMap = true;
        const key = readKey();
        skipWs();
        if (s[i] !== '=') throw new Error(`Expected = after key at ${i}`);
        i++;
        const value = readValue();
        map[key] = value;
        skipWs();
        continue;
      }
      throw new Error(`Unexpected table content at ${i}: ${s.slice(i, i + 40)}`);
    }

    if (isMap) return map;
    return items;
  }

  skipWs();
  if (s.startsWith('return', i)) {
    i += 6;
  }
  skipWs();
  const root = readTable();
  return root;
}

export function buildKeywordLists(tables) {
  const contextTable = tables.context;
  const interfacesTable = tables.interfaces;
  const texTable = tables.tex;

  const constants = [...(contextTable.constants ?? [])];
  const helpers = [...(contextTable.helpers ?? [])];
  const commands = [...(interfacesTable.common ?? [])];

  const overloaded = new Set([...helpers, ...constants]);
  const primitives = [];

  function addEngine(data) {
    if (!data) return;
    if (Array.isArray(data)) {
      for (const v of data) {
        if (v === '/' || v === '-' || v === ' ') continue;
        if (!overloaded.has(v)) primitives.push(v);
        const normal = `normal${v}`;
        if (!overloaded.has(normal)) primitives.push(normal);
      }
      return;
    }
    for (const v of Object.values(data)) {
      if (typeof v !== 'string') continue;
      if (v === '/' || v === '-' || v === ' ') continue;
      if (!overloaded.has(v)) primitives.push(v);
      const normal = `normal${v}`;
      if (!overloaded.has(normal)) primitives.push(normal);
    }
  }

  for (const key of ENGINE_KEYS) {
    addEngine(texTable[key]);
  }

  // Deduplicate while preserving first occurrence
  const uniq = (list) => {
    const seen = new Set();
    const out = [];
    for (const name of list) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  };

  return {
    constants: sortKeywords(uniq(constants)),
    helpers: sortKeywords(uniq(helpers)),
    primitives: sortKeywords(uniq(primitives)),
    commands: sortKeywords(uniq(commands)),
  };
}

function escapeRegex(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function wordsAlternation(list) {
  const sorted = sortKeywords(list);
  return sorted.map(escapeRegex).join('|');
}

export function keywordMatch(list) {
  const alt = wordsAlternation(list);
  // Capture backslash separately for punctuation scope; boundary matches mtx-vscode.
  return `(\\\\)(${alt})(?![a-zA-Z])`;
}

const IDENT = '[a-zA-Z_@!?\\x7f-\\xff]';

export function repositoryRules(lists) {
  return {
    constant: {
      match: keywordMatch(lists.constants),
      name: 'support.constant.context',
      captures: {
        '1': { name: 'punctuation.definition.constant.context' },
      },
    },
    helper: {
      match: keywordMatch(lists.helpers),
      name: 'support.function.builtin.context',
      captures: {
        '1': { name: 'punctuation.definition.function.context' },
      },
    },
    'interface-command': {
      match: keywordMatch(lists.commands),
      name: 'support.function.context',
      captures: {
        '1': { name: 'punctuation.definition.function.context' },
      },
    },
    ifprimitive: {
      match: `(\\\\)(if${IDENT}*)`,
      name: 'keyword.other.primitive.context',
      captures: {
        '1': { name: 'punctuation.definition.keyword.context' },
      },
    },
    primitive: {
      match: keywordMatch(lists.primitives),
      name: 'keyword.other.primitive.context',
      captures: {
        '1': { name: 'punctuation.definition.keyword.context' },
      },
    },
    reserved: {
      match: `(\\\\)((?:\\?\\?|[a-z]!)${IDENT}+)`,
      name: 'keyword.other.reserved.context',
      captures: {
        '1': { name: 'punctuation.definition.keyword.context' },
      },
    },
    'user-csname': {
      match: `(\\\\)${IDENT}+`,
      name: 'entity.name.function.context',
      captures: {
        '1': { name: 'punctuation.definition.function.context' },
      },
    },
  };
}

/** Ordered csname includes (after structure/embeds; before escape). */
export const KEYWORD_INCLUDES = [
  { include: '#constant' },
  { include: '#ifprimitive' },
  { include: '#helper' },
  { include: '#interface-command' },
  { include: '#primitive' },
  { include: '#reserved' },
  { include: '#user-csname' },
];

function patchGrammar(grammar, lists) {
  const repo = grammar.repository;
  if (!repo?.content?.patterns) {
    throw new Error('grammar missing repository.content.patterns');
  }

  const rules = repositoryRules(lists);
  for (const [key, rule] of Object.entries(rules)) {
    repo[key] = rule;
  }
  // Remove legacy single catch-all if present
  delete repo['control-sequence'];

  const patterns = repo.content.patterns;
  const withoutCs = patterns.filter(
    (p) =>
      p.include !== '#control-sequence' &&
      !KEYWORD_INCLUDES.some((k) => k.include === p.include),
  );

  // Insert keyword includes after #start-stop (or after #math if no start-stop)
  const startStopIdx = withoutCs.findIndex((p) => p.include === '#start-stop');
  const insertAt =
    startStopIdx >= 0
      ? startStopIdx + 1
      : Math.max(
          0,
          withoutCs.findIndex((p) => p.include === '#math') + 1,
        );

  repo.content.patterns = [
    ...withoutCs.slice(0, insertAt),
    ...KEYWORD_INCLUDES,
    ...withoutCs.slice(insertAt),
  ];

  // Math content also used #control-sequence — swap to keyword chain
  if (repo['math-content']?.patterns) {
    const mp = repo['math-content'].patterns.filter(
      (p) =>
        p.include !== '#control-sequence' &&
        !KEYWORD_INCLUDES.some((k) => k.include === p.include),
    );
    const ss = mp.findIndex((p) => p.include === '#start-stop');
    const at = ss >= 0 ? ss + 1 : mp.length;
    repo['math-content'].patterns = [
      ...mp.slice(0, at),
      ...KEYWORD_INCLUDES,
      ...mp.slice(at),
    ];
  }

  return grammar;
}

function resolveDataDir(argv) {
  const args = [...argv];
  let dataDir;
  let root;
  let outDir = join(REPO_ROOT, 'syntaxes');
  let grammarPath = join(REPO_ROOT, 'syntaxes', 'context.tmLanguage.json');

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--data-dir') dataDir = args[++i];
    else if (a === '--root') root = args[++i];
    else if (a === '--out-dir') outDir = args[++i];
    else if (a === '--grammar') grammarPath = args[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (dataDir) {
    return { dataDir: resolve(dataDir), root: root ?? null, outDir, grammarPath };
  }

  const envRoot =
    root ||
    process.env.CONTEXT_ROOT ||
    process.env.context_root ||
    '';

  let installRoot = resolveInstallRoot(envRoot) ?? (envRoot ? resolve(envRoot) : undefined);

  if (!installRoot) {
    const ctx = which('context') ?? which('mtxrun');
    if (ctx) {
      installRoot = walkToInstallRoot(ctx);
    }
  }

  if (!installRoot) {
    throw new Error(
      'Could not locate ConTeXt SciTE data. Set CONTEXT_ROOT to your ConTeXt installation root ' +
        '(parent of tex/), pass --root, pass --data-dir, or put context/mtxrun on PATH.',
    );
  }

  const resolved = resolveInstallRoot(installRoot) ?? installRoot;
  dataDir = join(resolved, SCITE_DATA_REL);
  if (!existsSync(dataDir)) {
    throw new Error(`SciTE data directory not found: ${dataDir}`);
  }
  return { dataDir, root: resolved, outDir, grammarPath };
}

function printHelp() {
  console.log(`Usage: node scripts/generate-context-keywords.mjs [options]

Options:
  --root <dir>       ConTeXt installation root (parent of tex/)
  --data-dir <dir>   Directory containing scite-context-data-*.lua
  --out-dir <dir>    Write context-keywords.json here (default: syntaxes/)
  --grammar <file>   Patch this TextMate grammar (default: syntaxes/context.tmLanguage.json)

Environment:
  CONTEXT_ROOT       Same as --root
`);
}

function tryLmtxVersion(root) {
  if (!root) return undefined;
  try {
    const mtx = findBinaryUnderRoot(root, 'mtxrun') ?? which('mtxrun');
    if (!mtx) return undefined;
    const out = execFileSync(mtx, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return line || undefined;
  } catch {
    return undefined;
  }
}

export function generateFromDataDir(dataDir, options = {}) {
  const paths = {};
  const hashes = {};
  const tables = {};

  for (const name of DATA_FILES) {
    const filePath = join(dataDir, name);
    if (!existsSync(filePath)) {
      throw new Error(`Missing SciTE data file: ${filePath}`);
    }
    paths[name] = filePath;
    hashes[name] = sha256File(filePath);
    const key = name
      .replace('scite-context-data-', '')
      .replace('.lua', '');
    tables[key] = parseLuaStringTables(readFileSync(filePath, 'utf8'));
  }

  const lists = buildKeywordLists(tables);
  const counts = {
    constants: lists.constants.length,
    helpers: lists.helpers.length,
    primitives: lists.primitives.length,
    commands: lists.commands.length,
  };

  const provenance = {
    generatedAt: new Date().toISOString(),
    interfaceSet: 'common',
    dataDir,
    root: options.root ?? null,
    lmtxVersion: options.lmtxVersion ?? tryLmtxVersion(options.root) ?? null,
    files: Object.fromEntries(
      DATA_FILES.map((name) => [
        name,
        { sha256: hashes[name], bytes: statSync(paths[name]).size },
      ]),
    ),
    counts,
    generator: 'scripts/generate-context-keywords.mjs',
    note:
      'Derived from ConTeXt LMTX SciTE tables (GPL-2). See NOTICE and LICENSE.',
  };

  return { lists, provenance, counts };
}

function main() {
  const { dataDir, root, outDir, grammarPath } = resolveDataDir(
    process.argv.slice(2),
  );
  const { lists, provenance, counts } = generateFromDataDir(dataDir, { root });

  mkdirSync(outDir, { recursive: true });
  const keywordsPath = join(outDir, 'context-keywords.json');
  const payload = {
    $comment:
      'Generated by npm run generate:keywords — do not hand-edit lists. GPL-2 derived data; see NOTICE.',
    provenance,
    constants: lists.constants,
    helpers: lists.helpers,
    primitives: lists.primitives,
    commands: lists.commands,
  };
  writeFileSync(keywordsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const patched = patchGrammar(grammar, lists);
  writeFileSync(grammarPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');

  const grammarBytes = statSync(grammarPath).size;
  console.log(
    `Wrote ${keywordsPath}\n` +
      `Patched ${grammarPath} (${grammarBytes} bytes)\n` +
      `counts: constants=${counts.constants} helpers=${counts.helpers} ` +
      `primitives=${counts.primitives} commands=${counts.commands}`,
  );

  if (grammarBytes > 250 * 1024) {
    console.warn(
      `Warning: grammar JSON is ${grammarBytes} bytes (soft ceiling 250 KiB).`,
    );
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
