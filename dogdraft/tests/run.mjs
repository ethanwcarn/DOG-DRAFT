/**
 * End-to-end API tests against an in-memory Postgres (PGlite).
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setTestDatabase } from '../lib/db.js';
import { BREEDS, GROUP_KEYS } from '../lib/breeds.js';
import { scorePlayers } from '../lib/scoring.js';

process.env.ADMIN_PASSWORD = 'test-admin-password';
// SESSION_SECRET intentionally unset: exercises the derived-key path
process.env.LOCK_AT = new Date(Date.now() + 3600e3).toISOString(); // unlocked

const pg = new PGlite();
setTestDatabase(async (text, params = []) => (await pg.query(text, params)).rows);

const picks = (await import('../api/picks.js')).default;
const state = (await import('../api/state.js')).default;
const admin = (await import('../api/admin.js')).default;
const breedsApi = (await import('../api/breeds.js')).default;

let ipCounter = 0;
async function call(handler, { method = 'POST', body, cookie, ip, headers = {}, url = '/' } = {}) {
  const req = {
    method,
    url,
    body,
    headers: {
      'content-type': 'application/json',
      host: 'dogdraft.test',
      'x-forwarded-for': ip || `10.0.0.${(ipCounter += 1) % 250}`,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  };
  const out = { status: 200, headers: {}, body: null };
  const res = {
    set statusCode(v) { out.status = v; },
    get statusCode() { return out.status; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    end(b) { out.body = b ? JSON.parse(b) : null; },
  };
  await handler(req, res);
  return out;
}

const byGroup = (g) => BREEDS.filter((b) => b.group === g).map((b) => b.id);
function makePicks(offset = 0) {
  const p = {};
  for (const g of GROUP_KEYS) p[g] = byGroup(g).slice(offset, offset + 3);
  return p;
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
}

console.log('Scoring unit tests');
await test('points, underdog doubling, BIS call bonus, tiebreak', () => {
  const players = [
    { id: 1, name: 'A', picks: { hound: ['x', 'y'] }, bisPick: 'x', createdAt: '2026-01-01' },
    { id: 2, name: 'B', picks: { hound: ['x', 'z'] }, bisPick: 'z', createdAt: '2026-01-02' },
    { id: 3, name: 'C', picks: { hound: ['x', 'z'] }, bisPick: 'x', createdAt: '2026-01-03' },
  ];
  const r = scorePlayers(players, { 'hound:1': 'x', 'hound:2': 'y', BIS: 'x' });
  // x picked by 3 (not underdog): 6 + 15 = 21. y picked by 1 (underdog): 3*2 = 6.
  const A = r.players.find((p) => p.id === 1);
  const C = r.players.find((p) => p.id === 3);
  assert.equal(A.total, 21 + 6 + 10);
  assert.equal(C.total, 21 + 10);
  assert.equal(r.players[0].id, 1);
  assert.equal(r.players.find((p) => p.id === 2).total, 21);
});
await test('true ties share rank; underdog applies to 2 pickers', () => {
  const players = [
    { id: 1, name: 'A', picks: { toy: ['p'] }, bisPick: 'p', createdAt: '1' },
    { id: 2, name: 'B', picks: { toy: ['p'] }, bisPick: 'p', createdAt: '2' },
  ];
  const r = scorePlayers(players, { 'toy:1': 'p' });
  assert.equal(r.players[0].total, 12);
  assert.equal(r.players[0].rank, 1);
  assert.equal(r.players[1].rank, 1);
});
await test('unentered optional placements score 0', () => {
  const r = scorePlayers([{ id: 1, name: 'A', picks: { toy: ['p', 'q'] }, bisPick: 'p', createdAt: '1' }], {});
  assert.equal(r.players[0].total, 0);
});

console.log('API tests');
const ann = { firstName: 'Ann', lastName: 'Lee', pin: '1234' };

await test('save requires 3 per group', async () => {
  const bad = makePicks();
  bad.toy = bad.toy.slice(0, 2);
  const r = await call(picks, { body: { action: 'save', ...ann, picks: bad, bisPick: bad.hound[0] } });
  assert.equal(r.status, 400);
});
await test('save rejects breed from the wrong group', async () => {
  const bad = makePicks();
  bad.toy = [byGroup('hound')[0], ...bad.toy.slice(1)];
  const r = await call(picks, { body: { action: 'save', ...ann, picks: bad, bisPick: bad.toy[1] } });
  assert.equal(r.status, 400);
});
await test('save rejects BIS call that is not one of your picks', async () => {
  const p = makePicks();
  const r = await call(picks, { body: { action: 'save', ...ann, picks: p, bisPick: byGroup('hound')[20] } });
  assert.equal(r.status, 400);
});
await test('save rejects bad PIN and bad names', async () => {
  const p = makePicks();
  assert.equal((await call(picks, { body: { action: 'save', ...ann, pin: '12a4', picks: p, bisPick: p.toy[0] } })).status, 400);
  assert.equal((await call(picks, { body: { action: 'save', ...ann, firstName: '<script>', picks: p, bisPick: p.toy[0] } })).status, 400);
});
await test('valid save creates entry; update needs same PIN', async () => {
  const p = makePicks();
  const r1 = await call(picks, { body: { action: 'save', ...ann, picks: p, bisPick: p.toy[0] } });
  assert.equal(r1.status, 201);
  const p2 = makePicks(3);
  const r2 = await call(picks, { body: { action: 'save', ...ann, lastName: 'LEE', picks: p2, bisPick: p2.toy[0] } });
  assert.equal(r2.status, 200, 'same name different case updates');
  const r3 = await call(picks, { body: { action: 'save', ...ann, pin: '9999', picks: p2, bisPick: p2.toy[0] } });
  assert.equal(r3.status, 403);
});
await test('load returns picks only with right PIN', async () => {
  const ok = await call(picks, { body: { action: 'load', ...ann } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.picks.toy, byGroup('toy').slice(3, 6));
  const bad = await call(picks, { body: { action: 'load', ...ann, pin: '0000' } });
  assert.equal(bad.status, 404);
  const nobody = await call(picks, { body: { action: 'load', firstName: 'No', lastName: 'Body', pin: '1234' } });
  assert.equal(nobody.status, 404);
});
await test('rate limit kicks in on repeated PIN guesses for one name', async () => {
  let last;
  for (let i = 0; i < 12; i += 1) {
    last = await call(picks, { body: { action: 'load', firstName: 'Ann', lastName: 'Lee', pin: String(1000 + i) } });
  }
  assert.equal(last.status, 429);
});
await test('cross-origin POST is rejected', async () => {
  const p = makePicks();
  const r = await call(picks, { body: { action: 'save', firstName: 'Eve', lastName: 'X', pin: '1111', picks: p, bisPick: p.toy[0] }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});
await test('non-JSON POST is rejected', async () => {
  const r = await call(picks, { body: {}, headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);
});

// More players for scoring
const bob = { firstName: 'Bob', lastName: 'Ray', pin: '2222' };
const cat = { firstName: 'Cat', lastName: 'Kim', pin: '3333' };
await call(picks, { body: { action: 'save', ...bob, picks: makePicks(0), bisPick: makePicks(0).hound[0] } });
await call(picks, { body: { action: 'save', ...cat, picks: makePicks(0), bisPick: makePicks(0).hound[1] } });

await test('state before lock hides picks', async () => {
  const r = await call(state, { method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, false);
  assert.equal(r.body.playerCount, 3);
  assert.equal(r.body.leaderboard[0].picks, undefined);
  assert.equal(r.body.pickCounts, null);
});

let cookie = '';
await test('admin requires login; wrong password rejected', async () => {
  assert.equal((await call(admin, { method: 'GET' })).status, 401);
  assert.equal((await call(admin, { body: { action: 'set', slot: 'hound:1', breedId: byGroup('hound')[0], reveal: true } })).status, 401);
  assert.equal((await call(admin, { body: { action: 'login', password: 'nope' } })).status, 401);
  const ok = await call(admin, { body: { action: 'login', password: 'test-admin-password' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict/);
  cookie = ok.headers['set-cookie'].split(';')[0];
});
await test('forged admin cookie rejected', async () => {
  const forged = cookie.replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await call(admin, { method: 'GET', cookie: forged })).status, 401);
});

// Lock the game now
process.env.LOCK_AT = new Date(Date.now() - 1000).toISOString();

await test('saving after lock is refused', async () => {
  const p = makePicks();
  const r = await call(picks, { body: { action: 'save', ...bob, picks: p, bisPick: p.toy[0] } });
  assert.equal(r.status, 423);
});

const H = byGroup('hound');
await test('admin validation: wrong group, BIS must be group winner, no duplicate places', async () => {
  assert.equal((await call(admin, { cookie, body: { action: 'set', slot: 'hound:1', breedId: byGroup('toy')[0], reveal: true } })).status, 400);
  assert.equal((await call(admin, { cookie, body: { action: 'set', slot: 'BIS', breedId: H[0], reveal: true } })).status, 400);
  assert.equal((await call(admin, { cookie, body: { action: 'set', slot: 'hound:1', breedId: H[0], reveal: true } })).status, 200);
  assert.equal((await call(admin, { cookie, body: { action: 'set', slot: 'hound:2', breedId: H[0], reveal: true } })).status, 409);
  assert.equal((await call(admin, { cookie, body: { action: 'set', slot: 'nope:1', breedId: H[0], reveal: true } })).status, 400);
});
await test('hidden results do not leak to public state', async () => {
  await call(admin, { cookie, body: { action: 'set', slot: 'hound:2', breedId: H[1], reveal: false } });
  const pub = await call(state, { method: 'GET' });
  assert.equal(pub.body.results['hound:2'], undefined);
  assert.equal(pub.body.results['hound:1'], H[0]);
  const adm = await call(admin, { method: 'GET', cookie });
  assert.equal(adm.body.results['hound:2'], H[1]);
  assert.equal(adm.body.revealed['hound:2'], false);
});
await test('scores after lock (underdog + BIS call)', async () => {
  // Bob & Cat picked H[0..2]; Ann picked H[3..5]. H[0] picked by 2 -> underdog x2.
  await call(admin, { cookie, body: { action: 'reveal', slots: ['hound:2'] } });
  await call(admin, { cookie, body: { action: 'set', slot: 'BIS', breedId: H[0], reveal: true } });
  const r = await call(state, { method: 'GET' });
  const bobRow = r.body.leaderboard.find((p) => p.name === 'Bob Ray');
  const catRow = r.body.leaderboard.find((p) => p.name === 'Cat Kim');
  // H[0]: (6 + 15) * 2 = 42; H[1] 2nd: 3 * 2 = 6; Bob BIS call H[0] +10
  assert.equal(bobRow.total, 42 + 6 + 10);
  assert.equal(catRow.total, 42 + 6);
  assert.equal(bobRow.rank, 1);
  assert.equal(r.body.pickCounts[H[0]], 2);
  assert.ok(Array.isArray(bobRow.picks.hound));
});
await test('BIS and RBIS cannot be the same dog', async () => {
  const r = await call(admin, { cookie, body: { action: 'set', slot: 'RBIS', breedId: H[0], reveal: true } });
  assert.equal(r.status, 409);
});
await test('reset requires typed confirmation', async () => {
  assert.equal((await call(admin, { cookie, body: { action: 'resetResults', confirm: 'yes' } })).status, 400);
  const ok = await call(admin, { cookie, body: { action: 'resetResults', confirm: 'RESET' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.results, {});
});
await test('breeds API lists local photos that exist on disk', async () => {
  const fs = await import('node:fs');
  const r = await call(breedsApi, { method: 'GET' });
  const withPhoto = r.body.breeds.filter((b) => b.photo);
  assert.ok(withPhoto.length > 150);
  for (const b of withPhoto) assert.ok(fs.existsSync(`public${b.photo}`), b.photo);
});
await test('no PIN hashes in any public response', async () => {
  const r = await call(state, { method: 'GET' });
  assert.ok(!JSON.stringify(r.body).includes('scrypt$'));
  const a = await call(admin, { method: 'GET', cookie });
  assert.ok(!JSON.stringify(a.body).includes('scrypt$'));
});

console.log('Fallback photo tests');
const fb = await import('../api/fallback-photos.js');
const fakeApi = (name, extra = {}) => ({
  id: name, type: 'breed',
  attributes: {
    name, other_names: extra.other || [],
    images: extra.noImages ? [] : [{ id: 1, url: `https://images.dogapi.dog/${name}.jpg`, medium: `https://images.dogapi.dog/m/${name}.jpg`,
      attribution: { author: 'Jane <b>Doe</b>', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', source_url: 'javascript:alert(1)' } }],
  },
});
await test('matches by name, alias, and other_names; rejects bad URLs', () => {
  const ours = BREEDS.filter((b) => ['plott-hound', 'pomeranian', 'belgian-sheepdog', 'chinook', 'keeshond'].includes(b.id));
  const api = [fakeApi('Plott'), fakeApi('Pomeranian'), fakeApi('Some Belgian', { other: ['Groenendael'] }), fakeApi('Chinook', { noImages: true })];
  const { photos, debug } = fb.matchPhotos(ours, api);
  assert.equal(photos['plott-hound'].src, 'https://images.dogapi.dog/m/Plott.jpg');
  assert.ok(photos.pomeranian && photos['belgian-sheepdog']);
  assert.equal(photos.chinook, undefined);
  assert.match(debug.chinook, /no images/);
  assert.match(debug.keeshond, /no Dog API breed/);
  assert.equal(photos.pomeranian.sourceUrl, null, 'javascript: URLs are dropped');
  assert.equal(photos.pomeranian.license, 'CC BY-SA 4.0');
});
await test('non-dogapi image hosts are ignored', () => {
  const ours = BREEDS.filter((b) => b.id === 'pomeranian');
  const bad = fakeApi('Pomeranian');
  bad.attributes.images[0].medium = 'https://evil.example/x.jpg';
  bad.attributes.images[0].url = 'https://evil.example/y.jpg';
  assert.equal(fb.matchPhotos(ours, [bad]).photos.pomeranian, undefined);
});
await test('wrong-variety photo is skipped for Belgian Sheepdog', () => {
  const ours = BREEDS.filter((b) => b.id === 'belgian-sheepdog');
  const rec = fakeApi('Belgian Sheepdog');
  rec.attributes.images[0].attribution.source_url = 'https://commons.wikimedia.org/wiki/File:Belgian_Malinois_01.jpg';
  assert.equal(fb.matchPhotos(ours, [rec]).photos['belgian-sheepdog'], undefined);
  rec.attributes.images.push({ ...rec.attributes.images[0], medium: 'https://images.dogapi.dog/g.jpg', attribution: { source_url: 'https://commons.wikimedia.org/wiki/File:Groenendael.jpg' } });
  assert.equal(fb.matchPhotos(ours, [rec]).photos['belgian-sheepdog'].src, 'https://images.dogapi.dog/g.jpg');
});
await test('endpoint pages through the API and survives an outage', async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      const page = Number(new URL(url).searchParams.get('page[number]'));
      const data = page === 1 ? Array.from({ length: 100 }, (_, i) => fakeApi(`Filler ${i}`)) : [fakeApi('Pomeranian')];
      return { ok: true, status: 200, json: async () => ({ data, links: page === 1 ? { next: 'x' } : {} }) };
    };
    const r = await call(fb.default, { method: 'GET', url: '/api/fallback-photos' });
    assert.equal(r.status, 200);
    assert.equal(calls, 2);
    assert.ok(r.body.photos.pomeranian);
    assert.match(r.headers['cache-control'], /s-maxage=604800/);
    globalThis.fetch = async () => { throw new Error('network down'); };
    const down = await call(fb.default, { method: 'GET', url: '/api/fallback-photos' });
    assert.equal(down.status, 200);
    assert.deepEqual(down.body.photos, {});
    assert.match(down.headers['cache-control'], /s-maxage=300/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
