import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Create a unique temp directory under os.tmpdir() with the given prefix. */
export async function makeTempDir(prefix = 'context-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}
