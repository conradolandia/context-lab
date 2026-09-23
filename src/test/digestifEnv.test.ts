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
import {
  inferRootFromBinary,
  isInstallRoot,
  resolveInstallRoot,
  walkToInstallRoot,
} from '../toolchain/paths';

/**
 * Sir's ConTeXt Standalone layout:
 *   {root}/tex/texmf-linux-64/bin/{context,mtxrun}
 *   {root}/tex/texmf-context/tex/context/interface/mkiv/context-en.xml
 */
async function makeSirLmtxLayout(opts?: {
  withXml?: boolean;
  withModules?: boolean;
}): Promise<{
  root: string;
  xmlPath?: string;
  contextBin: string;
  mtxrunBin: string;
  binDir: string;
  digestifFake: string;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lmtx-sir-'));
  const withXml = opts?.withXml !== false;

  const binDir = path.join(root, 'tex', 'texmf-linux-64', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const contextBin = path.join(binDir, 'context');
  const mtxrunBin = path.join(binDir, 'mtxrun');
  fs.writeFileSync(contextBin, '#!/bin/sh\n');
  fs.writeFileSync(mtxrunBin, '#!/bin/sh\n');
  fs.chmodSync(contextBin, 0o755);
  fs.chmodSync(mtxrunBin, 0o755);

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

  const digestifFake = path.join(root, 'fake-digestif');
  fs.writeFileSync(digestifFake, '#!/bin/sh\n');
  fs.chmodSync(digestifFake, 0o755);

  return { root, xmlPath, contextBin, mtxrunBin, binDir, digestifFake };
}

describe('Sir LMTX layout: install root resolution', () => {
  it('isInstallRoot accepts install root, rejects bin/', async () => {
    const { root, binDir } = await makeSirLmtxLayout();
    assert.equal(isInstallRoot(root), true);
    assert.equal(isInstallRoot(binDir), false);
    assert.equal(isInstallRoot(path.join(root, 'tex', 'texmf-linux-64')), false);
  });

  it('walkToInstallRoot from context binary reaches install root', async () => {
    const { root, contextBin } = await makeSirLmtxLayout();
    assert.equal(walkToInstallRoot(contextBin), root);
    assert.equal(inferRootFromBinary(contextBin), root);
  });

  it('resolveInstallRoot recovers when given bin/ or texmf-linux-64', async () => {
    const { root, binDir } = await makeSirLmtxLayout();
    assert.equal(resolveInstallRoot(root), path.resolve(root));
    assert.equal(resolveInstallRoot(binDir), root);
    assert.equal(resolveInstallRoot(path.join(root, 'tex', 'texmf-linux-64')), root);
  });
});

describe('Sir LMTX layout: Digestif XML + DIGESTIF_TEXMF', () => {
  it('finds XML under tex/texmf-context, never under bin/', async () => {
    const { root, xmlPath, binDir, digestifFake } = await makeSirLmtxLayout();
    assert.equal(findContextInterfaceXml(root), xmlPath);
    assert.ok(!xmlPath!.includes(`${path.sep}bin${path.sep}`));

    // Mistaken bin-as-root must not invent …/bin/tex/texmf-context/…
    assert.equal(findContextInterfaceXml(binDir), undefined);

    const fromBinSetting = buildDigestifEnv({
      root: binDir,
      digestifPath: digestifFake,
      baseEnv: { PATH: '/usr/bin' },
    });
    assert.equal(fromBinSetting.ok, true);
    if (!fromBinSetting.ok) {
      return;
    }
    assert.equal(fromBinSetting.root, root);
    assert.equal(fromBinSetting.interfaceXmlPath, xmlPath);
    assert.ok(!fromBinSetting.interfaceXmlPath.split(path.sep).includes('bin'));
    assert.ok(
      fromBinSetting.texmfDirs.every((d) => !d.endsWith(`${path.sep}bin`) && path.basename(d) !== 'bin'),
    );
    assert.ok(fromBinSetting.env.DIGESTIF_TEXMF?.includes(path.join(root, 'tex', 'texmf-context')));
    assert.ok(!fromBinSetting.env.DIGESTIF_TEXMF?.includes(binDir));
  });

  it('includes texmf-context and modules, skips platform binary texmf', async () => {
    const { root, xmlPath } = await makeSirLmtxLayout({ withModules: true });
    const dirs = collectTexmfDirs(root, xmlPath);
    assert.ok(dirs.some((d) => d.endsWith(path.join('tex', 'texmf-context'))));
    assert.ok(dirs.some((d) => d.endsWith(path.join('tex', 'texmf-modules'))));
    assert.ok(!dirs.some((d) => d.includes('texmf-linux-64')));
    assert.equal(texmfRootFromInterfaceXml(xmlPath!), path.join(root, 'tex', 'texmf-context'));
  });

  it('buildDigestifEnv with correct context.root', async () => {
    const { root, xmlPath, contextBin, digestifFake } = await makeSirLmtxLayout();
    const result = buildDigestifEnv({
      root,
      digestifPath: digestifFake,
      baseEnv: { PATH: '/usr/bin' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.root, root);
    assert.equal(result.interfaceXmlPath, xmlPath);
    assert.equal(
      result.interfaceXmlPath,
      path.join(root, 'tex', 'texmf-context', 'tex', 'context', 'interface', 'mkiv', 'context-en.xml'),
    );
    assert.ok(result.env.PATH?.includes(path.dirname(contextBin)));
  });
});

describe('resolveDigestifExecutable', () => {
  it('prefers absolute override when executable', async () => {
    const { digestifFake } = await makeSirLmtxLayout({ withXml: false });
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

describe('buildDigestifEnv errors', () => {
  it('fails clearly when Digestif is missing', async () => {
    const { root } = await makeSirLmtxLayout();
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
    const { root, digestifFake } = await makeSirLmtxLayout({ withXml: false });
    const result = buildDigestifEnv({
      root,
      digestifPath: digestifFake,
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.kind, 'xml-missing');
    assert.match(result.message, /context-en\.xml|install root/i);
  });

  it('fails when root is unset', async () => {
    const { digestifFake } = await makeSirLmtxLayout({ withXml: false });
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
