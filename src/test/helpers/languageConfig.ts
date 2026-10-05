import * as fs from 'node:fs';
import * as path from 'node:path';

/** Parsed language-configuration.json from the extension root. */
export function loadLanguageConfiguration(): {
  autoClosingPairs: Array<{ open: string; close: string }>;
  surroundingPairs: Array<[string, string]>;
  folding: { markers: { start: string; end: string } };
} {
  const candidates = [
    path.join(__dirname, '..', '..', 'language-configuration.json'),
    path.join(__dirname, '..', '..', '..', 'language-configuration.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
  }
  throw new Error('language-configuration.json not found');
}
