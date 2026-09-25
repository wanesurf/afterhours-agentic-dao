import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('apps/web/public/assets', { recursive: true });
await build({ entryPoints: ['apps/web/client/app.js'], outfile: 'apps/web/public/landing.js', bundle: true, minify: true, format: 'esm', target: 'es2022', legalComments: 'eof' });
await copyFile('node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', 'apps/web/public/assets/geist.woff2');
await copyFile('node_modules/@fontsource/marcellus/files/marcellus-latin-400-normal.woff2', 'apps/web/public/assets/marcellus.woff2');
