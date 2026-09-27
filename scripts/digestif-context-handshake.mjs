#!/usr/bin/env node
/**
 * Prove DigestiF ConTeXt mode: didOpen with languageId "context", then hover
 * on \starttext and/or completion on \setup return ConTeXt content.
 *
 * Requires: digestif on PATH (luarocks), DIGESTIF_TEXMF (or LMTX_ROOT) with
 * context-en.xml.
 *
 * Exit 0 on success, 2 if toolchain missing (skip), 1 on failure.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

function findContextXml(root) {
  const p = path.join(
    root,
    'tex',
    'texmf-context',
    'tex',
    'context',
    'interface',
    'mkiv',
    'context-en.xml',
  );
  return fs.existsSync(p) ? p : undefined;
}

function findDigestif() {
  const home = os.homedir();
  const candidates = [
    process.env.DIGESTIF?.trim(),
    path.join(home, '.luarocks', 'bin', 'digestif'),
    'digestif',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'digestif') {
      return c;
    }
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

const lmtxRoot =
  process.env.LMTX_ROOT?.trim() ||
  (fs.existsSync('/tmp/lmtx-install/tex/texmf-context') ? '/tmp/lmtx-install' : undefined);
const texmf =
  process.env.DIGESTIF_TEXMF?.trim() ||
  (lmtxRoot ? path.join(lmtxRoot, 'tex', 'texmf-context') : undefined);
const digestif = findDigestif();

if (!digestif) {
  console.log('SKIP: digestif not found (install luarocks digestif)');
  process.exit(2);
}
function hasContextXml(texmfRoot) {
  if (!texmfRoot) return false;
  return fs.existsSync(
    path.join(texmfRoot, 'tex', 'context', 'interface', 'mkiv', 'context-en.xml'),
  );
}
if (!texmf || !hasContextXml(texmf)) {
  console.log('SKIP: context-en.xml not found (set LMTX_ROOT or DIGESTIF_TEXMF)');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digestif-ctx-'));
const texPath = path.join(tmp, 'sample.tex');
const source = '\\starttext\nHello\n\\setup\n\\stoptext\n';
fs.writeFileSync(texPath, source);
const uri = pathToFileURL(texPath).href;

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

const env = {
  ...process.env,
  DIGESTIF_TEXMF: texmf,
  PATH: `${path.dirname(digestif)}:${process.env.PATH || ''}`,
};

console.log(`spawn: ${digestif}`);
console.log(`DIGESTIF_TEXMF=${texmf}`);
console.log(`uri=${uri}`);

const child = spawn(digestif, ['--verbose'], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = Buffer.alloc(0);
let stderr = '';
child.stderr.on('data', (c) => {
  stderr += c.toString('utf8');
});
child.stdout.on('data', (c) => {
  stdout = Buffer.concat([stdout, c]);
});

const messages = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: null,
      rootUri: pathToFileURL(tmp).href,
      capabilities: {},
    },
  },
  { jsonrpc: '2.0', method: 'initialized', params: {} },
  {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri,
        languageId: 'context',
        version: 1,
        text: source,
      },
    },
  },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'textDocument/hover',
    params: {
      textDocument: { uri },
      position: { line: 0, character: 3 },
    },
  },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'textDocument/completion',
    params: {
      textDocument: { uri },
      position: { line: 2, character: 6 },
    },
  },
];

for (const msg of messages) {
  child.stdin.write(frame(msg));
}

const results = new Map();
const deadline = Date.now() + 20_000;

function tryParse() {
  let text = stdout.toString('utf8');
  for (;;) {
    const m = text.match(/Content-Length:\s*(\d+)\r\n\r\n/);
    if (!m) {
      break;
    }
    const n = Number(m[1]);
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      break;
    }
    const start = headerEnd + 4;
    if (text.length < start + n) {
      break;
    }
    const payload = text.slice(start, start + n);
    text = text.slice(start + n);
    stdout = Buffer.from(text, 'utf8');
    try {
      const msg = JSON.parse(payload);
      if (msg.id != null) {
        results.set(msg.id, msg);
      }
    } catch {
      // ignore
    }
  }
}

function looksLikeContext(payload) {
  const s = JSON.stringify(payload).toLowerCase();
  return (
    s.includes('context') ||
    s.includes('starttext') ||
    s.includes('setup') ||
    s.includes('\\start') ||
    s.includes('texmf')
  );
}

const timer = setInterval(() => {
  tryParse();
  if (results.has(1) && results.has(2) && results.has(3)) {
    clearInterval(timer);
    finish();
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    finish();
  }
}, 50);

function finish() {
  child.kill('SIGTERM');
  const init = results.get(1);
  const hover = results.get(2);
  const completion = results.get(3);
  if (!init?.result?.capabilities) {
    console.error('FAIL: no initialize result');
    console.error(stderr.slice(-2000));
    process.exit(1);
  }
  // ConTeXt mode: hover or completion must carry ConTeXt-ish content, and stderr
  // should show context-en.xml tags generation when DIGESTIF_TEXMF is set.
  const hoverOk = hover?.result && looksLikeContext(hover.result);
  const compItems = completion?.result?.items ?? completion?.result ?? [];
  const compOk =
    Array.isArray(compItems) &&
    compItems.some((it) => /setup|start|context/i.test(JSON.stringify(it)));
  const loadedContextXml = /context-en\.xml/i.test(stderr);
  const loadedLatexOnly =
    /latex\.tags/i.test(stderr) && !/context-en\.xml/i.test(stderr) && !hoverOk && !compOk;

  console.log('hover:', hoverOk ? 'ConTeXt-like' : JSON.stringify(hover?.result)?.slice(0, 300));
  console.log(
    'completion items:',
    Array.isArray(compItems) ? compItems.length : typeof compItems,
  );
  console.log('stderr has context-en.xml:', loadedContextXml);
  if (loadedLatexOnly) {
    console.error('FAIL: DigestiF loaded LaTeX tags only (languageId was not ConTeXt?)');
    console.error(stderr.slice(-2000));
    process.exit(1);
  }
  if (!hoverOk && !compOk && !loadedContextXml) {
    console.error('FAIL: no ConTeXt hover/completion/tags evidence');
    console.error('stderr:\n' + stderr.slice(-2500));
    process.exit(1);
  }
  console.log('OK: DigestiF ConTeXt mode (languageId=context)');
  process.exit(0);
}
