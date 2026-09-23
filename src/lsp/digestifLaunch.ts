import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type DigestifLaunchMethod =
  | 'luametatex-luaonly'
  | 'texlua'
  | 'wrapper-path'
  | 'direct';

export interface DigestifLaunch {
  /** Executable to spawn (luametatex, texlua, or digestif wrapper). */
  command: string;
  /** Args including DigestiF main script when using a Lua interpreter. */
  args: string[];
  /** Env overrides merged on top of the caller env (e.g. LUA_PATH). */
  envOverrides: NodeJS.ProcessEnv;
  method: DigestifLaunchMethod;
  /** Human-readable explanation for Output. */
  detail: string;
  /** DigestiF home when known (self-install ~/.digestif). */
  digestifHome?: string;
  /** Absolute path to DigestiF's Lua entry script when known. */
  mainScript?: string;
}

export interface ResolveDigestifLaunchOptions {
  /** Path to `digestif` on PATH or context.digestifPath. */
  digestifPath: string;
  /** LMTX install root (optional; used to find luametatex). */
  root?: string;
  /** Already-resolved Lua interpreters from buildDigestifEnv. */
  luametatex?: string;
  texlua?: string;
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

/**
 * Decide how to spawn DigestiF under LMTX.
 *
 * The self-install wrapper does `exec texlua $DIGESTIF_HOME/bin/digestif`.
 * LMTX's `luametatex` is not a drop-in `texlua`: without `--luaonly` (and without
 * a `.lua` extension on the script) it treats the file as TeX and exits 1.
 * Prefer: `luametatex --luaonly $DIGESTIF_HOME/bin/digestif` with LUA_PATH set.
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

  // Case A: PATH entry is the self-install wrapper → launch main via luametatex --luaonly
  if (text.startsWith('#!') && isSelfInstallWrapper(text)) {
    const mainScript = fs.existsSync(mainFromHome) ? mainFromHome : undefined;
    if (luametatex && mainScript) {
      return {
        command: luametatex,
        args: ['--luaonly', mainScript],
        envOverrides: {
          LUA_PATH: `${home}/?.lua;${home}/?/init.lua;;`,
          DIGESTIF_HOME: home,
        },
        method: 'luametatex-luaonly',
        detail:
          `self-install wrapper → ${path.basename(luametatex)} --luaonly ${mainScript} ` +
          `(LMTX needs --luaonly; bare texlua→luametatex symlink is not enough)`,
        digestifHome: home,
        mainScript,
      };
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
    // Fall through to running the wrapper as-is (shim may help)
    return {
      command: digestifPath,
      args: [],
      envOverrides: {},
      method: 'wrapper-path',
      detail:
        `running wrapper ${digestifPath} on PATH` +
        (luametatex ? ' (ensure texlua shim uses luametatex --luaonly)' : ' (no luametatex found)'),
      digestifHome: home,
      mainScript: mainScript && fs.existsSync(mainScript) ? mainScript : undefined,
    };
  }

  // Case B: digestifPath is already the Lua main script
  if (isDigestifLuaMain(text)) {
    const mainScript = digestifPath;
    const digestifHome = path.dirname(path.dirname(mainScript));
    if (luametatex) {
      return {
        command: luametatex,
        args: ['--luaonly', mainScript],
        envOverrides: {
          LUA_PATH: `${digestifHome}/?.lua;${digestifHome}/?/init.lua;;`,
          DIGESTIF_HOME: digestifHome,
        },
        method: 'luametatex-luaonly',
        detail: `Lua main → ${path.basename(luametatex)} --luaonly ${mainScript}`,
        digestifHome,
        mainScript,
      };
    }
    if (texlua) {
      return {
        command: texlua,
        args: [mainScript],
        envOverrides: {
          LUA_PATH: `${digestifHome}/?.lua;${digestifHome}/?/init.lua;;`,
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
 * Write a `texlua` shim that runs `luametatex --luaonly "$@"`.
 * A bare symlink is wrong: luametatex without --luaonly treats extension-less
 * DigestiF scripts as TeX input and exits 1.
 */
export function writeTexluaLuaonlyShim(
  luametatexPath: string,
  shimDir?: string,
): { shimDir: string; shimPath: string } | undefined {
  try {
    const dir = shimDir ?? path.join(os.homedir(), '.cache', 'context-synctex', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const shimPath = path.join(dir, process.platform === 'win32' ? 'texlua.cmd' : 'texlua');
    if (process.platform === 'win32') {
      const body =
        `@echo off\r\n"${luametatexPath}" --luaonly %*\r\n`;
      fs.writeFileSync(shimPath, body, 'utf8');
    } else {
      const body =
        `#!/bin/sh\n` +
        `# context-synctex: DigestiF wrapper expects texlua; LMTX needs --luaonly\n` +
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
