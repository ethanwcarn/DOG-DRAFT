/**
 * Local dev server for browser testing: serves public/ and routes /api/* to
 * the real handlers backed by in-memory Postgres. Not deployed.
 *   node tests/dev-server.mjs [port]
 * Dev-only helpers: GET /__dev/lock?state=open|locked
 * Images are stubbed to the placeholder (no internet needed).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { setTestDatabase } from '../lib/db.js';

process.env.ADMIN_PASSWORD ||= 'dev-admin-password';
process.env.SESSION_SECRET ||= 'd'.repeat(48);
process.env.LOCK_AT ||= new Date(Date.now() + 2 * 86400e3).toISOString();

const pg = new PGlite();
setTestDatabase(async (t, p = []) => (await pg.query(t, p)).rows);

// Optional fake Google for browser tests: DEV_FAKE_GOOGLE=1 node tests/dev-server.mjs
let devGoogleKey = null;
if (process.env.DEV_FAKE_GOOGLE) {
  const crypto = await import('node:crypto');
  const { setTestGoogleKeys } = await import('../lib/google.js');
  process.env.GOOGLE_CLIENT_ID = 'dev-test.apps.googleusercontent.com';
  devGoogleKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  setTestGoogleKeys([{ ...devGoogleKey.publicKey.export({ format: 'jwk' }), kid: 'dev', alg: 'RS256' }]);
  globalThis.__mintGoogle = (sub, given, family) => {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', kid: 'dev' });
    const body = b64({ iss: 'accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, sub, iat: now, exp: now + 3600, given_name: given, family_name: family });
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), devGoogleKey.privateKey).toString('base64url')}`;
  };
}

const handlers = {};
for (const n of ['breeds', 'state', 'picks', 'admin', 'fallback-photos', 'auth']) handlers[n] = (await import(`../api/${n}.js`)).default;

const pub = path.resolve('public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__dev/lock') {
    process.env.LOCK_AT = new Date(Date.now() + (url.searchParams.get('state') === 'locked' ? -1000 : 2 * 86400e3)).toISOString();
    return res.end('ok');
  }
  if (url.pathname === '/__dev/gtoken' && globalThis.__mintGoogle) {
    const q = url.searchParams;
    return res.end(globalThis.__mintGoogle(q.get('sub') || '1', q.get('given') || '', q.get('family') || ''));
  }
  if (url.pathname === '/__dev/legacy') {
    // Make an entry look like it was saved before multiple Best in Show calls existed
    await pg.query('UPDATE players SET bis_picks = NULL');
    return res.end('ok');
  }
  if (url.pathname === '/api/img') {
    res.writeHead(302, { Location: '/placeholder.svg' });
    return res.end();
  }
  const m = /^\/api\/([\w-]+)$/.exec(url.pathname);
  if (m && handlers[m[1]]) {
    let raw = '';
    for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : undefined;
    const origSet = res.setHeader.bind(res);
    // Local http: drop the Secure flag so the browser keeps cookies (handles lists of cookies too)
    const insecure = (c) => String(c).replace('; Secure', '');
    res.setHeader = (k, v) => origSet(k, k.toLowerCase() === 'set-cookie' ? (Array.isArray(v) ? v.map(insecure) : insecure(v)) : v);
    return handlers[m[1]](req, res);
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (file === '/admin') file = '/admin.html';
  try {
    const full = path.join(pub, path.normalize(file));
    if (!full.startsWith(pub)) throw new Error('nope');
    const data = await fs.readFile(full);
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(Number(process.argv[2] || 3000), () => console.log('dev server up'));
