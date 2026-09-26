import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type DigestifLaunchMethod =
  | 'direct'
  | 'luametatex-bootstrap'
  | 'texlua'
  | 'wrapper-path';

export type DigestifResolveSource =
  | 'override'
  | 'path'
  | 'luarocks'
  | 'checkout-bootstrap';

export interface DigestifLaunch {
  /** Executable to spawn (digestif binary, lua, or luametatex). */
  command: string;
  /** Args including DigestiF main/bootstrap script when using a Lua interpreter. */
  args: string[];
  /** Env overrides merged on top of the caller env (e.g. LUA_PATH, DIGESTIF_HOME). */
  envOverrides: NodeJS.ProcessEnv;
  method: DigestifLaunchMethod;
  /** How the executable was chosen. */
  source: DigestifResolveSource;
  /** Human-readable explanation for Output. */
  detail: string;
  /** DigestiF home when known (self-install / git checkout ~/.digestif). */
  digestifHome?: string;
  /** Absolute path to DigestiF's Lua entry script when known. */
  mainScript?: string;
  /** Absolute path to LMTX bootstrap when used. */
  bootstrapPath?: string;
}

export interface ResolveDigestifLaunchOptions {
  /** Path to `digestif` (override, PATH, luarocks, or checkout bin). */
  digestifPath: string;
  /** How digestifPath was resolved. */
  source: DigestifResolveSource;
  /** LMTX install root (optional). */
  root?: string;
  /** Already-resolved Lua interpreters from buildDigestifEnv. */
  luametatex?: string;
  texlua?: string;
  /**
   * Absolute path to resources/digestif-lmtx-bootstrap.lua.
   * Used only for checkout-bootstrap fallback under LMTX.
   */
  bootstrapPath?: string;
  /** Override DIGESTIF_HOME for tests. */
  digestifHome?: string;
  /** Injected homedir for tests. */
  homedir?: string;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Detect DigestiF self-install shell wrapper (scripts/digestif). */
export function isSelfInstallWrapper(scriptText: string): boolean {
  return (
    scriptText.includes('DIGESTIF_HOME') &&
    scriptText.includes('DIGESTIF_REPO') &&
    /exec\s+"\$LUA"/.test(scriptText)
  );
}

/** Detect DigestiF Lua entry (bin/digestif) or luarocks bin. */
export function isDigestifLuaMain(scriptText: string): boolean {
  return (
    scriptText.includes('digestif.langserver') ||
    /require\s+[\"']digestif\.langserver[\"']/.test(scriptText)
  );
}

/**
 * Resolve DIGESTIF_HOME: explicit override, parse wrapper assignment, or ~/.digestif.
 */
export function resolveDigestifHome(options: {
  wrapperText?: string;
  digestifHome?: string;
  homedir?: string;
}): string {
  if (options.digestifHome?.trim()) {
    return options.digestifHome.trim();
  }
  const text = options.wrapperText ?? '';
  const match = text.match(/DIGESTIF_HOME=["']([^"']+)["']/);
  if (match?.[1]) {
    const raw = match[1].replace(/\$HOME/g, options.homedir ?? os.homedir());
    return raw;
  }
  return path.join(options.homedir ?? os.homedir(), '.digestif');
}

/** True when ~/.digestif looks like a DigestiF git checkout / self-install. */
export function isDigestifCheckoutHome(home: string): boolean {
  return (
    fs.existsSync(path.join(home, 'digestif', 'langserver.lua')) ||
    fs.existsSync(path.join(home, 'bin', 'digestif'))
  );
}

export function digestifDataDir(home: string): string | undefined {
  const data = path.join(home, 'data');
  return fs.existsSync(data) ? data : undefined;
}

function checkoutEnvOverrides(home: string, bootstrapPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LUA_PATH: `${home}/?.lua;${home}/?/init.lua;;`,
    DIGESTIF_HOME: home,
  };
  const data = digestifDataDir(home);
  if (data) {
    env.DIGESTIF_DATA = data;
  }
  if (bootstrapPath) {
    env.CONTEXT_SYNCTEX_DIGESTIF_BOOTSTRAP = bootstrapPath;
  }
  return env;
}

function lmtxBootstrapLaunch(
  luametatex: string,
  home: string,
  bootstrapPath: string,
  mainScript: string | undefined,
  why: string,
): DigestifLaunch {
  return {
    command: luametatex,
    args: ['--luaonly', bootstrapPath],
    envOverrides: checkoutEnvOverrides(home, bootstrapPath),
    method: 'luametatex-bootstrap',
    source: 'checkout-bootstrap',
    detail:
      `${why} → ${path.basename(luametatex)} --luaonly ${bootstrapPath} ` +
      `(fallback when no digestif on PATH/luarocks; LMTX needs path-searcher bootstrap)`,
    digestifHome: home,
    mainScript,
    bootstrapPath,
  };
}

function directLaunch(
  digestifPath: string,
  source: DigestifResolveSource,
  detail: string,
  home?: string,
): DigestifLaunch {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (home) {
    envOverrides.DIGESTIF_HOME = home;
    const data = digestifDataDir(home);
    if (data) {
      envOverrides.DIGESTIF_DATA = data;
    }
  }
  return {
    command: digestifPath,
    args: [],
    envOverrides,
    method: 'direct',
    source,
    detail,
    digestifHome: home,
    mainScript: isDigestifLuaMain(readText(digestifPath) ?? '') ? digestifPath : undefined,
  };
}

/**
 * Decide how to spawn DigestiF.
 *
 * Launch order (Sir / LMTX):
 * 1. context.digestifPath set → run as-is (no luametatex wrap)
 * 2. digestif on PATH or ~/.luarocks/bin → run as-is (luarocks supplies lpeg/lfs)
 * 3. Else luametatex + bootstrap against ~/.digestif checkout
 */
export function resolveDigestifLaunch(options: ResolveDigestifLaunchOptions): DigestifLaunch {
  const digestifPath = options.digestifPath;
  const text = readText(digestifPath) ?? '';
  const home = resolveDigestifHome({
    wrapperText: text,
    digestifHome: options.digestifHome,
    homedir: options.homedir,
  });
  const luametatex = options.luametatex;
  const bootstrap =
    options.bootstrapPath && fs.existsSync(options.bootstrapPath)
      ? options.bootstrapPath
      : undefined;

  // 1–2: override / PATH / luarocks → always direct (shebang → system lua, or luarocks bin)
  if (options.source === 'override') {
    return directLaunch(
      digestifPath,
      'override',
      `context.digestifPath → direct exec ${digestifPath} (no luametatex wrap)`,
      isDigestifCheckoutHome(home) ? home : undefined,
    );
  }
  if (options.source === 'path' || options.source === 'luarocks') {
    return directLaunch(
      digestifPath,
      options.source,
      `${options.source} → direct exec ${digestifPath}`,
      isDigestifCheckoutHome(home) ? home : undefined,
    );
  }

  // 3: checkout-bootstrap fallback under LMTX
  if (options.source === 'checkout-bootstrap') {
    const mainScript = fs.existsSync(path.join(home, 'bin', 'digestif'))
      ? path.join(home, 'bin', 'digestif')
      : isDigestifLuaMain(text)
        ? digestifPath
        : undefined;
    if (luametatex && bootstrap && isDigestifCheckoutHome(home)) {
      return lmtxBootstrapLaunch(
        luametatex,
        home,
        bootstrap,
        mainScript,
        '~/.digestif checkout',
      );
    }
    // Last resort: run checkout bin via shebang if present
    if (mainScript) {
      return directLaunch(
        mainScript,
        'checkout-bootstrap',
        `checkout bin without luametatex/bootstrap → direct ${mainScript}`,
        home,
      );
    }
  }

  // Legacy: wrapper on PATH that we somehow classified oddly — still prefer direct
  if (text.startsWith('#!') && isSelfInstallWrapper(text)) {
    return directLaunch(
      digestifPath,
      options.source,
      `wrapper → direct exec ${digestifPath}`,
      home,
    );
  }

  return directLaunch(digestifPath, options.source, `direct exec ${digestifPath}`, home);
}

/**
 * Write a `texlua` shim that prefers the LMTX DigestiF bootstrap when available.
 * Only used when DigestiF's self-install wrapper is invoked and needs a texlua.
 */
export function writeTexluaLuaonlyShim(
  luametatexPath: string,
  shimDir?: string,
  bootstrapPath?: string,
): { shimDir: string; shimPath: string } | undefined {
  try {
    const dir = shimDir ?? path.join(os.homedir(), '.cache', 'context-synctex', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const shimPath = path.join(dir, process.platform === 'win32' ? 'texlua.cmd' : 'texlua');
    const boot = bootstrapPath ?? '';
    if (process.platform === 'win32') {
      const body =
        `@echo off\r\n` +
        `if defined CONTEXT_SYNCTEX_DIGESTIF_BOOTSTRAP (\r\n` +
        `  "${luametatexPath}" --luaonly "%CONTEXT_SYNCTEX_DIGESTIF_BOOTSTRAP%" %*\r\n` +
        `) else if exist "${boot}" (\r\n` +
        `  "${luametatexPath}" --luaonly "${boot}" %*\r\n` +
        `) else (\r\n` +
        `  "${luametatexPath}" --luaonly %*\r\n` +
        `)\r\n`;
      fs.writeFileSync(shimPath, body, 'utf8');
    } else {
      const body =
        `#!/bin/sh\n` +
        `# context-synctex: DigestiF under LMTX needs luametatex --luaonly + path-searcher bootstrap\n` +
        `BOOT="\${CONTEXT_SYNCTEX_DIGESTIF_BOOTSTRAP:-${boot}}"\n` +
        `if [ -n "$BOOT" ] && [ -f "$BOOT" ]; then\n` +
        `  case "$1" in *digestif*) shift ;; esac\n` +
        `  exec "${luametatexPath}" --luaonly "$BOOT" "$@"\n` +
        `fi\n` +
        `exec "${luametatexPath}" --luaonly "$@"\n`;
      fs.writeFileSync(shimPath, body, { mode: 0o755 });
      fs.chmodSync(shimPath, 0o755);
    }
    return { shimDir: dir, shimPath };
  } catch {
    return undefined;
  }
}

export function findLuametatexUnderRoot(root: string): string | undefined {
  const names = process.platform === 'win32' ? ['luametatex.exe'] : ['luametatex'];
  const candidates = [
    path.join(root, 'tex', 'texmf-linux-64', 'bin'),
    path.join(root, 'tex', 'texmf-linux-aarch64', 'bin'),
    path.join(root, 'tex', 'texmf-osx-64', 'bin'),
    path.join(root, 'tex', 'texmf-osx-arm64', 'bin'),
    path.join(root, 'tex', 'texmf-mswin', 'bin'),
    path.join(root, 'bin'),
  ];
  for (const dir of candidates) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (isExecutable(p)) {
        return p;
      }
    }
  }
  return undefined;
}

/** Resolve bootstrap.lua next to the extension. */
export function resolveBootstrapPath(extensionPath: string): string | undefined {
  const candidates = [
    path.join(extensionPath, 'resources', 'digestif-lmtx-bootstrap.lua'),
    path.join(extensionPath, 'dist', 'resources', 'digestif-lmtx-bootstrap.lua'),
    path.join(extensionPath, '..', 'resources', 'digestif-lmtx-bootstrap.lua'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

/** ~/.luarocks/bin/digestif when present. */
export function findLuarocksDigestif(homedir?: string): string | undefined {
  const home = homedir ?? os.homedir();
  const candidates = [
    path.join(home, '.luarocks', 'bin', 'digestif'),
    path.join(home, '.luarocks', 'bin', 'digestif.bat'),
  ];
  return candidates.find(isExecutable);
}
