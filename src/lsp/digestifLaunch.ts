import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type DigestifLaunchMethod = 'direct';

export type DigestifResolveSource = 'override' | 'luarocks' | 'path';

export interface DigestifLaunch {
  command: string;
  args: string[];
  /** Only DIGESTIF_* overrides; never PATH / TEXMF* pollution. */
  envOverrides: NodeJS.ProcessEnv;
  method: DigestifLaunchMethod;
  source: DigestifResolveSource;
  detail: string;
}

export interface ResolveDigestifLaunchOptions {
  digestifPath: string;
  source: DigestifResolveSource;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * DigestiF is always launched as-is (shebang / luarocks bin).
 * No luametatex wrap, no ~/.digestif bootstrap.
 */
export function resolveDigestifLaunch(options: ResolveDigestifLaunchOptions): DigestifLaunch {
  const { digestifPath, source } = options;
  const detail =
    source === 'override'
      ? `context.digestifPath → direct ${digestifPath}`
      : source === 'luarocks'
        ? `~/.luarocks/bin → direct ${digestifPath}`
        : `PATH → direct ${digestifPath}`;
  return {
    command: digestifPath,
    args: [],
    envOverrides: {},
    method: 'direct',
    source,
    detail,
  };
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
