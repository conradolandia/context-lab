import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  constrainHoverImageSize,
  FIGURE_HOVER_MAX_HEIGHT,
  FIGURE_HOVER_MAX_WIDTH,
  figureHoverImgHtml,
} from '../links/figureHoverMarkdown';
import { parseImageSize, readImageSize } from '../links/imageSize';

/** Minimal valid 1x1 PNG, then claim large IHDR for size-parse tests via custom builder. */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Build a valid PNG with given pixel dimensions (solid black, 1 byte/pixel gray). */
function buildPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + width, 0); // filter byte + pixels
  const raw = Buffer.alloc((1 + width) * height);
  for (let y = 0; y < height; y++) {
    row.copy(raw, y * row.length);
  }
  const idat = zlib.deflateSync(raw);
  const iend = Buffer.alloc(0);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', iend),
  ]);
}

describe('constrainHoverImageSize', () => {
  it('scales a wide image to max width', () => {
    const s = constrainHoverImageSize(4000, 2000);
    assert.equal(s.width, FIGURE_HOVER_MAX_WIDTH);
    assert.equal(s.height, Math.round((2000 * FIGURE_HOVER_MAX_WIDTH) / 4000));
    assert.ok(s.height <= FIGURE_HOVER_MAX_HEIGHT);
  });

  it('scales a tall image to max height', () => {
    const s = constrainHoverImageSize(1000, 4000);
    assert.equal(s.height, FIGURE_HOVER_MAX_HEIGHT);
    assert.ok(s.width <= FIGURE_HOVER_MAX_WIDTH);
  });

  it('keeps small images at natural size', () => {
    assert.deepEqual(constrainHoverImageSize(120, 80), { width: 120, height: 80 });
  });
});

describe('figureHoverImgHtml', () => {
  it('emits constrained HTML img markup', () => {
    const html = figureHoverImgHtml('file:///tmp/big.png', 'big.png', {
      width: 360,
      height: 180,
    });
    assert.match(html, /width="360"/);
    assert.match(html, /height="180"/);
    assert.match(html, new RegExp(`max-width:${FIGURE_HOVER_MAX_WIDTH}px`));
    assert.match(html, new RegExp(`max-height:${FIGURE_HOVER_MAX_HEIGHT}px`));
    assert.match(html, /object-fit:contain/);
    assert.match(html, /alt="big\.png"/);
  });

  it('escapes alt text', () => {
    const html = figureHoverImgHtml('file:///a.png', 'a<"&>.png');
    assert.match(html, /alt="a&lt;&quot;&amp;&gt;\.png"/);
  });
});

describe('parseImageSize / readImageSize', () => {
  it('reads IHDR from a large synthetic PNG', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-png-'));
    const file = path.join(dir, 'huge.png');
    const png = buildPng(2400, 1800);
    fs.writeFileSync(file, png);
    assert.ok(png.length > 100);
    assert.deepEqual(parseImageSize(png), { width: 2400, height: 1800 });
    assert.deepEqual(readImageSize(file), { width: 2400, height: 1800 });
    const constrained = constrainHoverImageSize(2400, 1800);
    assert.ok(constrained.width <= FIGURE_HOVER_MAX_WIDTH);
    assert.ok(constrained.height <= FIGURE_HOVER_MAX_HEIGHT);
    assert.equal(constrained.width, 360);
    assert.equal(constrained.height, 270);
  });
});
