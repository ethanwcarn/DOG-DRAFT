/**
 * Builds public/botid.js, the browser half of Vercel BotID.
 *
 * The site has no bundler, and botid/client/core reads process.env.NODE_ENV,
 * which doesn't exist in a browser. esbuild inlines it as "production" and
 * bundles everything into one ES module that index.html loads before app.js,
 * so BotID's fetch wrapper is in place before the app sends any request.
 *
 * Re-run after upgrading the botid package:  npm run build:botid
 * The protected paths must match BOTID_PROTECTED in lib/botid.js (a test checks this).
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOTID_PROTECTED } from '../lib/botid.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}node_modules/botid/package.json`, 'utf8')).version;

await build({
  entryPoints: [`${root}scripts/botid-entry.js`],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  define: {
    'process.env.NODE_ENV': '"production"',
    __BOTID_PROTECTED__: JSON.stringify(BOTID_PROTECTED),
  },
  banner: { js: `/* Vercel BotID client ${version}, built by scripts/build-botid.mjs. Do not edit. */` },
  outfile: `${root}public/botid.js`,
  logLevel: 'info',
});
