import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DEFAULT_PDF_PANEL_TITLE,
  pdfPanelTitle,
} from '../viewer/pdfPanelTitle';

describe('pdfPanelTitle', () => {
  it('returns basename for a full path', () => {
    assert.equal(
      pdfPanelTitle(path.join('job', 'out', 'erroresMetabolismo.pdf')),
      'erroresMetabolismo.pdf',
    );
  });

  it('returns basename for a bare filename', () => {
    assert.equal(pdfPanelTitle('preview.pdf'), 'preview.pdf');
  });

  it('falls back when path is missing or empty', () => {
    assert.equal(pdfPanelTitle(undefined), DEFAULT_PDF_PANEL_TITLE);
    assert.equal(pdfPanelTitle(''), DEFAULT_PDF_PANEL_TITLE);
  });

  it('never embeds parent directories in the title', () => {
    const title = pdfPanelTitle('/home/user/docs/job/chapter.pdf');
    assert.equal(title, 'chapter.pdf');
    assert.ok(!title.includes('/'));
    assert.ok(!title.includes('\\'));
  });
});
