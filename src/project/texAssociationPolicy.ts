import * as path from 'node:path';

/** Pure helper for tests: whether we should show the *.tex → ConTeXt prompt. */
export function shouldOfferTexContextAssociation(options: {
  filePath: string;
  languageId?: string;
  dontAsk?: boolean;
  existingAssociation?: string;
}): boolean {
  if (path.extname(options.filePath).toLowerCase() !== '.tex') {
    return false;
  }
  if (options.languageId === 'context') {
    return false;
  }
  if (options.dontAsk) {
    return false;
  }
  if (options.existingAssociation === 'context') {
    return false;
  }
  return true;
}
