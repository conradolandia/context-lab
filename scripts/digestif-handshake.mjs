#!/usr/bin/env node
/**
 * Scripted DigestiF LSP initialize handshake.
 *
 * Proves that `luametatex --luaonly` + digestif-lmtx-bootstrap.lua answers
 * initialize. Bare `luametatex --luaonly ~/.digestif/bin/digestif` does not
 * (LuaMetaTeX package.searchers cannot load DigestiF from package.path).
 *
 * Env (optional overrides):
 *   LMTX_ROOT, DIGESTIF_HOME, DIGESTIF_TEXMF, LUAMETATEX, BOOTSTRAP
 *
 * Exit 0 on success, 2 if toolchain missing (skip), 1 on handshake failure.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function isExe(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findLuametatex(root) {
  if (!root) return undefined;
  const bins = [
    path.join(root, 'tex', 'texmf-linux-64', 'bin', 'luametatex'),
    path.join(root, 'tex', 'texmf-linux-aarch64', 'bin', 'luametatex'),
    path.join(root, 'tex', 'texmf-osx-64', 'bin', 'luametatex'),
    path.join(root, 'tex', 'texmf-osx-arm64', 'bin', 'luametatex'),
  ];
  return bins.find(isExe);
}

function findTexmfContext(root) {
  const p = path.join(root, 'tex', 'texmf-context');
  return fs.existsSync(p) ? p : undefined;
}

const digestifHome = process.env.DIGESTIF_HOME?.trim() || path.join(os.homedir(), '.digestif');
const lmtxRoot =
  process.env.LMTX_ROOT?.trim() ||
  (fs.existsSync('/tmp/lmtx-install') ? '/tmp/lmtx-install' : undefined);
const luametatex =
  process.env.LUAMETATEX?.trim() || findLuametatex(lmtxRoot);
const texmf =
  (lmtxRoot ? findTexmfContext(lmtxRoot) : undefined) ||
  process.env.DIGESTIF_TEXMF?.trim();
const bootstrap =
  process.env.BOOTSTRAP?.trim() ||
  path.join(repoRoot, 'resources', 'digestif-lmtx-bootstrap.lua');

if (!luametatex || !isExe(luametatex)) {
  console.log('SKIP: luametatex not found (set LMTX_ROOT or LUAMETATEX)');
  process.exit(2);
}
if (!fs.existsSync(path.join(digestifHome, 'digestif', 'langserver.lua'))) {
  console.log(`SKIP: DigestiF not installed at ${digestifHome}`);
  process.exit(2);
}
if (!fs.existsSync(bootstrap)) {
  console.error(`FAIL: bootstrap missing: ${bootstrap}`);
  process.exit(1);
}
if (!texmf) {
  console.log('SKIP: DIGESTIF_TEXMF / texmf-context not found');
  process.exit(2);
}

const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    processId: null,
    rootUri: null,
    capabilities: {},
  },
});
const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;

const env = {
  ...process.env,
  DIGESTIF_HOME: digestifHome,
  DIGESTIF_TEXMF: texmf,
  LUA_PATH: `${digestifHome}/?.lua;${digestifHome}/?/init.lua;;`,
};

const args = ['--luaonly', bootstrap, '--verbose'];
console.log(`spawn: ${luametatex} ${args.join(' ')}`);
console.log(`DIGESTIF_HOME=${digestifHome}`);
console.log(`DIGESTIF_TEXMF=${texmf}`);

const child = spawn(luametatex, args, {
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

const timeoutMs = 12_000;
const timer = setTimeout(() => {
  child.kill('SIGKILL');
  console.error('FAIL: initialize timed out');
  console.error('stderr:\n' + stderr.slice(0, 2000));
  console.error('stdout:\n' + stdout.toString('utf8').slice(0, 2000));
  process.exit(1);
}, timeoutMs);

child.stdin.write(frame);

function tryParse() {
  const text = stdout.toString('utf8');
  const m = text.match(/Content-Length:\s*(\d+)\r?\n\r?\n/);
  if (!m) return false;
  const n = Number(m[1]);
  const headerEnd = text.indexOf('\r\n\r\n');
  if (headerEnd < 0) return false;
  const payload = text.slice(headerEnd + 4, headerEnd + 4 + n);
  if (payload.length < n) return false;
  let msg;
  try {
    msg = JSON.parse(payload);
  } catch {
    return false;
  }
  clearTimeout(timer);
  child.kill('SIGTERM');
  if (msg.result?.serverInfo?.name === 'Digestif' || msg.result?.capabilities) {
    console.log('OK: DigestiF answered initialize');
    console.log(JSON.stringify(msg.result?.serverInfo ?? msg.result?.capabilities, null, 2));
    process.exit(0);
  }
  console.error('FAIL: unexpected initialize response', payload.slice(0, 500));
  process.exit(1);
}

child.stdout.on('data', () => {
  tryParse();
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (tryParse()) return;
  console.error(`FAIL: DigestiF exited code=${code} signal=${signal}`);
  console.error('stderr:\n' + stderr.slice(0, 2000));
  console.error('stdout:\n' + stdout.toString('utf8').slice(0, 2000));
  process.exit(1);
});
