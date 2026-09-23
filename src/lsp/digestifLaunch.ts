import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type DigestifLaunchMethod =
  | 'luametatex-bootstrap'
  | 'texlua'
  | 'wrapper-path'
  | 'direct';

export interface DigestifLaunch {
  /** Executable to spawn (luametatex, texlua, or digestif wrapper). */
  command: string;
  /** Args including DigestiF main/bootstrap script when using a Lua interpreter. */
  args: string[];
  /** Env overrides merged on top of the caller env (e.g. LUA_PATH, DIGESTIF_HOME). */
  envOverrides: NodeJS.ProcessEnv;
  method: DigestifLaunchMethod;
  /** Human-readable explanation for Output. */
  detail: string;
  /** DigestiF home when known (self-install ~/.digestif). */
  digestifHome?: string;
  /** Absolute path to DigestiF's Lua entry script when known. */
  mainScript?: string;
  /** Absolute path to LMTX bootstrap when used. */
  bootstrapPath?: string;
}

export interface ResolveDigestifLaunchOptions {
  /** Path to `digestif` on PATH or context.digestifPath. */
  digestifPath: string;
  /** LMTX install root (optional; used to find luametatex). */
  root?: string;
  /** Already-resolved Lua interpreters from buildDigestifEnv. */
  luametatex?: string;
  texlua?: string;
  /**
   * Absolute path to resources/digestif-lmtx-bootstrap.lua.
   * Required for reliable DigestiF under LuaMetaTeX (broken package.searchers).
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
    envOverrides: {
      LUA_PATH: `${home}/?.lua;${home}/?/init.lua;;`,
      DIGESTIF_HOME: home,
      CONTEXT_SYNCTEX_DIGESTIF_BOOTSTRAP: bootstrapPath,
    },
    method: 'luametatex-bootstrap',
    detail:
      `${why} → ${path.basename(luametatex)} --luaonly ${bootstrapPath} ` +
      `(LMTX package.searchers cannot load DigestiF from package.path without bootstrap)`,
    digestifHome: home,
    mainScript,
    bootstrapPath,
  };
}

/**
 * Decide how to spawn DigestiF under LMTX.
 *
 * LuaMetaTeX needs `--luaonly` and a bootstrap that installs a normal
 * package.path searcher — stock searchers[2] does not load from package.path,
 * so `require "digestif.langserver"` fails or DigestiF never answers initialize.
 */
export function resolveDigestifLaunch(options: ResolveDigestifLaunchOptions): DigestifLaunch {
  const digestifPath = options.digestifPath;
  const text = readText(digestifPath) ?? '';
  const home = resolveDigestifHome({
    wrapperText: text,
    digestifHome: options.digestifHome,
    homedir: options.homedir,
  });
  const mainFromHome = path.join(home, 'bin', 'digestif');
  const luametatex = options.luametatex;
  const texlua = options.texlua;
  const bootstrap =
    options.bootstrapPath && fs.existsSync(options.bootstrapPath)
      ? options.bootstrapPath
      : undefined;

  // Case A: PATH entry is the self-install wrapper
  if (text.startsWith('#!') && isSelfInstallWrapper(text)) {
    const mainScript = fs.existsSync(mainFromHome) ? mainFromHome : undefined;
    if (luametatex && bootstrap && (mainScript || fs.existsSync(home))) {
      return lmtxBootstrapLaunch(
        luametatex,
        home,
        bootstrap,
        mainScript,
        'self-install wrapper',
      );
    }
    if (texlua && mainScript && texlua !== luametatex) {
      return {
        command: texlua,
        args: [mainScript],
        envOverrides: {
          LUA_PATH: `${home}/?.lua;${home}/?/init.lua;;`,
          DIGESTIF_HOME: home,
        },
        method: 'texlua',
        detail: `self-install wrapper → texlua ${mainScript}`,
        digestifHome: home,
        mainScript,
      };
    }
    return {
      command: digestifPath,
      args: [],
      envOverrides: bootstrap
        ? { CONTEXT_SYNCTEX_DIGESTIF_BOOTSTRAP: bootstrap, DIGESTIF_HOME: home }
        : {},
      method: 'wrapper-path',
      detail:
        `running wrapper ${digestifPath} on PATH` +
        (luametatex
          ? bootstrap
            ? ' (texlua shim should redirect to LMTX bootstrap)'
            : ' (no bootstrap path — DigestiF may fail under LMTX)'
          : ' (no luametatex found)'),
      digestifHome: home,
      mainScript: mainScript && fs.existsSync(mainScript) ? mainScript : undefined,
      bootstrapPath: bootstrap,
    };
  }

  // Case B: digestifPath is already the Lua main script
  if (isDigestifLuaMain(text)) {
    const mainScript = digestifPath;
    const digestifHome = path.dirname(path.dirname(mainScript));
    if (luametatex && bootstrap) {
      return lmtxBootstrapLaunch(
        luametatex,
        digestifHome,
        bootstrap,
        mainScript,
        'Lua main',
      );
    }
    if (texlua) {
      return {
        command: texlua,
        args: [mainScript],
        envOverrides: {
          LUA_PATH: `${digestifHome}/?.lua;${digestifHome}/?/init.lua;;`,
          DIGESTIF_HOME: digestifHome,
        },
        method: 'texlua',
        detail: `Lua main → texlua ${mainScript}`,
        digestifHome,
        mainScript,
      };
    }
  }

  // Case C: luarocks / other — run executable directly
  return {
    command: digestifPath,
    args: [],
    envOverrides: {},
    method: 'direct',
    detail: `direct exec ${digestifPath}`,
  };
}

/**
 * Write a `texlua` shim that prefers the LMTX DigestiF bootstrap when available.
 * Falls back to `luametatex --luaonly "$@"`.
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
        `  # DigestiF wrapper passes $DIGESTIF_HOME/bin/digestif as $1; drop it.\n` +
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

/** Resolve bootstrap.lua next to the extension (dev: resources/, built: dist/../resources or resources/). */
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
