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

const handlers = {};
for (const n of ['breeds', 'state', 'picks', 'admin']) handlers[n] = (await import(`../api/${n}.js`)).default;

const pub = path.resolve('public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__dev/lock') {
    process.env.LOCK_AT = new Date(Date.now() + (url.searchParams.get('state') === 'locked' ? -1000 : 2 * 86400e3)).toISOString();
    return res.end('ok');
  }
  if (url.pathname === '/api/img') {
    res.writeHead(302, { Location: '/placeholder.svg' });
    return res.end();
  }
  const m = /^\/api\/(\w+)$/.exec(url.pathname);
  if (m && handlers[m[1]]) {
    let raw = '';
    for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : undefined;
    const origSet = res.setHeader.bind(res);
    res.setHeader = (k, v) => origSet(k, k.toLowerCase() === 'set-cookie' ? String(v).replace('; Secure', '') : v);
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
