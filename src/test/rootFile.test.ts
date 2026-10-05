import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseMagicRoot,
  resolveComponentProduct,
  resolveRootFile,
  resolveRootFileSetting,
} from '../project/rootFile';

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-root-'));
}

describe('rootFile magic comment', () => {
  it('parses % !TEX root relative to the active file', async () => {
    const dir = await makeTempDir();
    const main = path.join(dir, 'main.tex');
    const chap = path.join(dir, 'chap', 'a.tex');
    fs.mkdirSync(path.dirname(chap), { recursive: true });
    fs.writeFileSync(main, '\\starttext\n\\stoptext\n');
    const text = '% !TEX root = ../main.tex\n\\startcomponent\n';
    fs.writeFileSync(chap, text);
    const hit = parseMagicRoot(text, chap);
    assert.equal(hit, main);
  });
});

describe('rootFile component→product', () => {
  it('resolves \\product next to a \\startcomponent file', async () => {
    const dir = await makeTempDir();
    const product = path.join(dir, 'book.tex');
    const comp = path.join(dir, 'include', 'chap.tex');
    fs.mkdirSync(path.dirname(comp), { recursive: true });
    fs.writeFileSync(
      product,
      '\\startproduct book\n\\component include/chap\n\\stopproduct\n',
    );
    const compText =
      '\\startcomponent include/chap\n\\product book\n\\project myproj\n\\stopcomponent\n';
    fs.writeFileSync(comp, compText);
    const hit = resolveComponentProduct(comp, compText, [dir]);
    assert.equal(hit, product);
  });
});

describe('resolveRootFileSetting', () => {
  it('returns undefined for empty / whitespace setting', () => {
    assert.equal(resolveRootFileSetting('', ['/ws']), undefined);
    assert.equal(resolveRootFileSetting('   ', ['/ws']), undefined);
  });

  it('keeps absolute paths', () => {
    const abs = path.resolve('/tmp/main.tex');
    assert.equal(resolveRootFileSetting(abs, ['/ws']), abs);
  });

  it('resolves relative to the first workspace folder', () => {
    const folders = ['/ws/a', '/ws/b'];
    assert.equal(
      resolveRootFileSetting('docs/main.tex', folders),
      path.resolve('/ws/a', 'docs/main.tex'),
    );
  });

  it('resolves relative to the active file when no workspace folders', () => {
    const active = '/home/user/proj/chap/a.tex';
    assert.equal(
      resolveRootFileSetting('../main.tex', [], active),
      path.resolve('/home/user/proj/chap', '../main.tex'),
    );
  });

  it('falls back to cwd resolve when no folders and no active file', () => {
    assert.equal(
      resolveRootFileSetting('main.tex', []),
      path.resolve('main.tex'),
    );
  });
});

describe('resolveRootFile order', () => {
  it('prefers setting, then magic, then product, then active', async () => {
    const dir = await makeTempDir();
    const settingMain = path.join(dir, 'setting.tex');
    const magicMain = path.join(dir, 'magic.tex');
    const product = path.join(dir, 'prod.tex');
    const active = path.join(dir, 'active.tex');
    fs.writeFileSync(settingMain, '\\starttext\\stoptext\n');
    fs.writeFileSync(magicMain, '\\starttext\\stoptext\n');
    fs.writeFileSync(product, '\\startproduct prod\\stopproduct\n');
    fs.writeFileSync(
      active,
      '% !TEX root = magic.tex\n\\startcomponent\n\\product prod\n',
    );

    const viaSetting = resolveRootFile({
      activeFile: active,
      activeText: fs.readFileSync(active, 'utf8'),
      rootFileSetting: 'setting.tex',
      workspaceFolders: [dir],
    });
    assert.equal(viaSetting.rule, 'setting:context.rootFile');
    assert.equal(viaSetting.rootFile, settingMain);

    const viaMagic = resolveRootFile({
      activeFile: active,
      activeText: fs.readFileSync(active, 'utf8'),
      workspaceFolders: [dir],
    });
    assert.equal(viaMagic.rule, 'magic:% !TEX root');
    assert.equal(viaMagic.rootFile, magicMain);

    const viaProduct = resolveRootFile({
      activeFile: active,
      activeText: '\\startcomponent\n\\product prod\n',
      workspaceFolders: [dir],
    });
    assert.equal(viaProduct.rule, 'structure:component→product');
    assert.equal(viaProduct.rootFile, product);

    const viaActive = resolveRootFile({
      activeFile: active,
      activeText: '\\starttext\nhello\n',
      workspaceFolders: [dir],
    });
    assert.equal(viaActive.rule, 'fallback:active');
    assert.equal(viaActive.rootFile, active);
  });
});
