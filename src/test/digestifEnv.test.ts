import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildDigestifEnv,
  collectTexmfDirs,
  CONTEXT_INTERFACE_REL,
  findContextInterfaceXml,
  resolveDigestifExecutable,
  texmfRootFromInterfaceXml,
} from '../lsp/digestifEnv';

async function makeFakeLmtx(opts?: {
  withXml?: boolean;
  withModules?: boolean;
  withBin?: boolean;
}): Promise<{ root: string; xmlPath?: string; digestifFake: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lmtx-fake-'));
  const withXml = opts?.withXml !== false;

  let xmlPath: string | undefined;
  if (withXml) {
    xmlPath = path.join(root, CONTEXT_INTERFACE_REL);
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(
      xmlPath,
      '<?xml version="1.0"?>\n<cd:interface xmlns:cd="http://www.pragma-ade.com/commands">\n</cd:interface>\n',
    );
  }

  if (opts?.withModules) {
    const modXml = path.join(
      root,
      'tex',
      'texmf-modules',
      'tex',
      'context',
      'third',
      'something',
      't-foo.xml',
    );
    fs.mkdirSync(path.dirname(modXml), { recursive: true });
    fs.writeFileSync(modXml, '<cd:interface/>\n');
  }

  if (opts?.withBin) {
    const bin = path.join(root, 'bin', 'linux-64');
    fs.mkdirSync(bin, { recursive: true });
    const stub = path.join(bin, 'context');
    fs.writeFileSync(stub, '#!/bin/sh\n');
    fs.chmodSync(stub, 0o755);
  }

  const digestifFake = path.join(root, 'fake-digestif');
  fs.writeFileSync(digestifFake, '#!/bin/sh\n');
  fs.chmodSync(digestifFake, 0o755);

  return { root, xmlPath, digestifFake };
}

describe('findContextInterfaceXml', () => {
  it('finds canonical mkiv context-en.xml under LMTX root', async () => {
    const { root, xmlPath } = await makeFakeLmtx();
    assert.equal(findContextInterfaceXml(root), xmlPath);
  });

  it('returns undefined when XML is absent', async () => {
    const { root } = await makeFakeLmtx({ withXml: false });
    assert.equal(findContextInterfaceXml(root), undefined);
  });
});

describe('collectTexmfDirs / texmfRootFromInterfaceXml', () => {
  it('includes texmf-context and sibling texmf-modules', async () => {
    const { root, xmlPath } = await makeFakeLmtx({ withModules: true });
    const dirs = collectTexmfDirs(root, xmlPath);
    assert.ok(dirs.some((d) => d.endsWith(path.join('tex', 'texmf-context'))));
    assert.ok(dirs.some((d) => d.endsWith(path.join('tex', 'texmf-modules'))));
    assert.equal(texmfRootFromInterfaceXml(xmlPath!), path.join(root, 'tex', 'texmf-context'));
  });
});

describe('resolveDigestifExecutable', () => {
  it('prefers absolute override when executable', async () => {
    const { digestifFake } = await makeFakeLmtx({ withXml: false });
    assert.equal(resolveDigestifExecutable(digestifFake, () => '/usr/bin/digestif'), digestifFake);
  });

  it('falls back to which() when override empty', async () => {
    assert.equal(
      resolveDigestifExecutable('', () => '/mock/bin/digestif'),
      '/mock/bin/digestif',
    );
  });

  it('returns undefined when override is not executable', async () => {
    const missing = path.join(os.tmpdir(), 'no-such-digestif-bin');
    assert.equal(resolveDigestifExecutable(missing, () => '/mock/bin/digestif'), undefined);
  });
});

describe('buildDigestifEnv', () => {
  it('builds DIGESTIF_TEXMF and PATH for a fake LMTX tree', async () => {
    const { root, xmlPath, digestifFake } = await makeFakeLmtx({ withBin: true });
    const result = buildDigestifEnv({
      root,
      digestifPath: digestifFake,
      baseEnv: { PATH: '/usr/bin', HOME: '/tmp' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.digestifPath, digestifFake);
    assert.equal(result.interfaceXmlPath, xmlPath);
    assert.ok(result.texmfDirs.length >= 1);
    assert.equal(
      result.env.DIGESTIF_TEXMF,
      result.texmfDirs.join(process.platform === 'win32' ? ';' : ':'),
    );
    assert.ok(result.env.PATH?.includes(path.join(root, 'bin')));
    assert.ok(result.env.PATH?.includes('/usr/bin'));
  });

  it('fails clearly when Digestif is missing', async () => {
    const { root } = await makeFakeLmtx();
    const result = buildDigestifEnv({
      root,
      whichDigestif: () => undefined,
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.kind, 'digestif-missing');
    assert.match(result.message, /Digestif/i);
  });

  it('fails clearly when interface XML is missing', async () => {
    const { root, digestifFake } = await makeFakeLmtx({ withXml: false });
    const result = buildDigestifEnv({
      root,
      digestifPath: digestifFake,
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.kind, 'xml-missing');
    assert.match(result.message, /context-en\.xml/);
  });

  it('fails when root is unset', async () => {
    const { digestifFake } = await makeFakeLmtx({ withXml: false });
    const result = buildDigestifEnv({
      digestifPath: digestifFake,
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.kind, 'xml-missing');
    assert.match(result.message, /context\.root/);
  });
});
