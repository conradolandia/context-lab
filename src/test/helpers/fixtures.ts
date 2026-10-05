import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Candidate fixture roots for dist vs src layouts.
 * Bundled tests run from dist/test/; __dirname is that outdir.
 */
function fixtureRoots(): string[] {
  return [
    path.join(__dirname, 'fixtures'),
    path.join(__dirname, '..', '..', 'src', 'test', 'fixtures'),
  ];
}

/** Absolute path to a fixture file under src/test/fixtures (or dist copy). */
export function resolveFixturePath(...parts: string[]): string {
  for (const root of fixtureRoots()) {
    const candidate = path.join(root, ...parts);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`fixture not found: ${parts.join('/')}`);
}

/** UTF-8 contents of a fixture file. */
export function readFixture(...parts: string[]): string {
  return fs.readFileSync(resolveFixturePath(...parts), 'utf8');
}
