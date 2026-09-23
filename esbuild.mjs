import * as esbuild from 'esbuild';
import { mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

mkdirSync(join(__dirname, 'dist'), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: [join(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: join(__dirname, 'dist/extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const testOptions = {
  entryPoints: [
    join(__dirname, 'src/test/artifactGate.test.ts'),
    join(__dirname, 'src/test/mtxSynctex.test.ts'),
    join(__dirname, 'src/test/pdfServer.test.ts'),
    join(__dirname, 'src/test/coords.test.ts'),
    join(__dirname, 'src/test/rootFile.test.ts'),
  ],
  bundle: true,
  outdir: join(__dirname, 'dist/test'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

function copyPdfJsAssets() {
  const pdfjsRoot = join(__dirname, 'node_modules/pdfjs-dist');
  const mediaViewer = join(__dirname, 'media/viewer');
  mkdirSync(mediaViewer, { recursive: true });

  const buildDir = join(pdfjsRoot, 'build');
  if (!existsSync(buildDir)) {
    console.warn('pdfjs-dist build assets not found; run npm install first');
    return;
  }

  const vendor = join(mediaViewer, 'pdfjs');
  if (existsSync(vendor)) {
    rmSync(vendor, { recursive: true, force: true });
  }
  mkdirSync(vendor, { recursive: true });
  cpSync(join(buildDir, 'pdf.min.mjs'), join(vendor, 'pdf.min.mjs'));
  cpSync(join(buildDir, 'pdf.worker.min.mjs'), join(vendor, 'pdf.worker.min.mjs'));
}

function copyTestFixtures() {
  const src = join(__dirname, 'src/test/fixtures');
  const dest = join(__dirname, 'dist/test/fixtures');
  if (!existsSync(src)) {
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

async function buildOnce() {
  await esbuild.build(extensionOptions);
  await esbuild.build(testOptions);
  copyPdfJsAssets();
  copyTestFixtures();
}

if (watch) {
  const extCtx = await esbuild.context(extensionOptions);
  const testCtx = await esbuild.context(testOptions);
  await Promise.all([extCtx.watch(), testCtx.watch()]);
  copyPdfJsAssets();
  copyTestFixtures();
  console.log('watching…');
} else {
  await buildOnce();
}
