import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shouldOfferTexContextAssociation } from '../project/texAssociationPolicy';

describe('tex → ConTeXt association prompt policy', () => {
  it('offers for .tex when language is not context', () => {
    assert.equal(
      shouldOfferTexContextAssociation({
        filePath: '/tmp/job.tex',
        languageId: 'plaintext',
      }),
      true,
    );
  });

  it('skips when already context, dontAsk, or association set', () => {
    assert.equal(
      shouldOfferTexContextAssociation({
        filePath: '/tmp/job.tex',
        languageId: 'context',
      }),
      false,
    );
    assert.equal(
      shouldOfferTexContextAssociation({
        filePath: '/tmp/job.tex',
        languageId: 'tex',
        dontAsk: true,
      }),
      false,
    );
    assert.equal(
      shouldOfferTexContextAssociation({
        filePath: '/tmp/job.tex',
        languageId: 'tex',
        existingAssociation: 'context',
      }),
      false,
    );
  });

  it('skips non-.tex', () => {
    assert.equal(
      shouldOfferTexContextAssociation({
        filePath: '/tmp/job.mkiv',
        languageId: 'plaintext',
      }),
      false,
    );
  });
});

describe('DigestiF ConTeXt languageId handshake', () => {
  it('loads context-en.xml when languageId is context', () => {
    const candidates = [
      path.resolve(process.cwd(), 'scripts', 'digestif-context-handshake.mjs'),
      path.resolve(process.cwd(), '..', 'scripts', 'digestif-context-handshake.mjs'),
      path.resolve(process.cwd(), '..', '..', 'scripts', 'digestif-context-handshake.mjs'),
    ];
    const script = candidates.find((c) => fs.existsSync(c));
    if (!script) {
      console.log('SKIP: handshake script missing');
      return;
    }
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LMTX_ROOT: process.env.LMTX_ROOT || '/tmp/lmtx-install',
        PATH: `${path.join(process.env.HOME || '', '.luarocks', 'bin')}:${process.env.PATH || ''}`,
      },
      timeout: 45_000,
    });
    if (result.status === 2) {
      console.log(result.stdout || result.stderr);
      return;
    }
    assert.equal(
      result.status,
      0,
      `handshake failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stdout ?? '', /OK: DigestiF ConTeXt mode/);
  });
});
