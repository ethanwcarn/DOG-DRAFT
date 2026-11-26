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
process.env.NODE_ENV = 'test'; // lets tests move LOCK_AT later than the real lock
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
    // Multiple cookies arrive as a list; join them so tests can match on text.
    setHeader(k, v) { out.headers[k.toLowerCase()] = Array.isArray(v) ? v.join('\n') : v; },
    getHeader(k) { return out.headers[k.toLowerCase()]; },
    end(b) { out.body = b ? JSON.parse(b) : null; },
  };
  await handler(req, res);
  return out;
}

const byGroup = (g) => BREEDS.filter((b) => b.group === g).map((b) => b.id);
/** Three valid Best in Show calls from a set of picks. */
const bis = (p) => [p.toy[0], p.hound[0], p.sporting[0]];

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
    { id: 1, name: 'A', picks: { hound: ['x', 'y'] }, bisPicks: ['x'], createdAt: '2026-01-01' },
    { id: 2, name: 'B', picks: { hound: ['x', 'z'] }, bisPicks: ['z'], createdAt: '2026-01-02' },
    { id: 3, name: 'C', picks: { hound: ['x', 'z'] }, bisPicks: ['x'], createdAt: '2026-01-03' },
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
await test('true ties share rank; 2 pickers is NOT an underdog (solo only)', () => {
  const players = [
    { id: 1, name: 'A', picks: { toy: ['p'] }, bisPicks: ['p'], createdAt: '1' },
    { id: 2, name: 'B', picks: { toy: ['p'] }, bisPicks: ['p'], createdAt: '2' },
  ];
  const r = scorePlayers(players, { 'toy:1': 'p' });
  assert.equal(r.players[0].total, 6, 'shared pick: no x2');
  assert.equal(r.players[0].rank, 1);
  assert.equal(r.players[1].rank, 1);
});
await test('unentered optional placements score 0', () => {
  const r = scorePlayers([{ id: 1, name: 'A', picks: { toy: ['p', 'q'] }, bisPicks: ['p'], createdAt: '1' }], {});
  assert.equal(r.players[0].total, 0);
});

console.log('API tests');
const ann = { firstName: 'Ann', lastName: 'Lee', pin: '1234' };

await test('save requires 3 per group', async () => {
  const bad = makePicks();
  bad.toy = bad.toy.slice(0, 2);
  const r = await call(picks, { body: { action: 'save', ...ann, picks: bad, bisPicks: bis(makePicks()) } });
  assert.equal(r.status, 400);
});
await test('save rejects breed from the wrong group', async () => {
  const bad = makePicks();
  bad.toy = [byGroup('hound')[0], ...bad.toy.slice(1)];
  const r = await call(picks, { body: { action: 'save', ...ann, picks: bad, bisPicks: [bad.toy[1], bad.hound[0], bad.sporting[0]] } });
  assert.equal(r.status, 400);
});
await test('save rejects BIS call that is not one of your picks', async () => {
  const p = makePicks();
  const r = await call(picks, { body: { action: 'save', ...ann, picks: p, bisPicks: [byGroup('hound')[20], p.toy[0], p.sporting[0]] } });
  assert.equal(r.status, 400);
});
await test('save rejects bad PIN and bad names', async () => {
  const p = makePicks();
  assert.equal((await call(picks, { body: { action: 'save', ...ann, pin: '12a4', picks: p, bisPicks: bis(p) } })).status, 400);
  assert.equal((await call(picks, { body: { action: 'save', ...ann, firstName: '<script>', picks: p, bisPicks: bis(p) } })).status, 400);
});
await test('valid save creates entry; update needs same PIN', async () => {
  const p = makePicks();
  const r1 = await call(picks, { body: { action: 'save', ...ann, picks: p, bisPicks: bis(p) } });
  assert.equal(r1.status, 201);
  const p2 = makePicks(3);
  const r2 = await call(picks, { body: { action: 'save', ...ann, lastName: 'LEE', picks: p2, bisPicks: bis(p2) } });
  assert.equal(r2.status, 200, 'same name different case updates');
  const r3 = await call(picks, { body: { action: 'save', ...ann, pin: '9999', picks: p2, bisPicks: bis(p2) } });
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
  const r = await call(picks, { body: { action: 'save', firstName: 'Eve', lastName: 'X', pin: '1111', picks: p, bisPicks: bis(p) }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});
await test('non-JSON POST is rejected', async () => {
  const r = await call(picks, { body: {}, headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);
});

await test('one entry per device: second name from same browser is refused', async () => {
  const p = makePicks();
  const first = await call(picks, { body: { action: 'save', firstName: 'Dee', lastName: 'Vice', pin: '5555', picks: p, bisPicks: bis(p) } });
  assert.equal(first.status, 201);
  const cookie = first.headers['set-cookie'];
  assert.match(cookie, /^dd_device=[a-f0-9]{32}; Path=\/api; HttpOnly; Secure; SameSite=Lax/);
  const dev = cookie.split(';')[0];
  // Same browser, different name -> refused with a helpful message
  const second = await call(picks, { cookie: dev, body: { action: 'save', firstName: 'Dee', lastName: 'Two', pin: '5555', picks: p, bisPicks: bis(p) } });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already has an entry for Dee Vice/);
  // Same browser can still edit its own entry
  const edit = await call(picks, { cookie: dev, body: { action: 'save', firstName: 'Dee', lastName: 'Vice', pin: '5555', picks: makePicks(3), bisPicks: bis(makePicks(3)) } });
  assert.equal(edit.status, 200);
  // A different browser (no cookie) can create its own entry
  const other = await call(picks, { body: { action: 'save', firstName: 'Other', lastName: 'Phone', pin: '6666', picks: p, bisPicks: bis(p) } });
  assert.equal(other.status, 201);
  // Loading an entry on a new browser tags it, so it can't then make a second entry
  const load = await call(picks, { body: { action: 'load', firstName: 'Dee', lastName: 'Vice', pin: '5555' } });
  assert.equal(load.status, 200);
  const laptop = load.headers['set-cookie'].split(';')[0];
  assert.equal(laptop, dev, 'laptop gets the same device id as the entry');
  const sneaky = await call(picks, { cookie: laptop, body: { action: 'save', firstName: 'Dee', lastName: 'Three', pin: '5555', picks: p, bisPicks: bis(p) } });
  assert.equal(sneaky.status, 409);
  // Malformed cookies are ignored rather than trusted
  const junk = await call(picks, { cookie: 'dd_device=../../etc', body: { action: 'save', firstName: 'Junk', lastName: 'Cookie', pin: '7777', picks: p, bisPicks: bis(p) } });
  assert.equal(junk.status, 201);
  // Clean up so later scoring tests see the same 3 players as before
  await pg.query("DELETE FROM players WHERE name_key IN ('dee vice', 'other phone', 'junk cookie')");
});

await test('Best in Show calls: exactly 3, distinct, from your own picks', async () => {
  const p = makePicks();
  const base = { action: 'save', firstName: 'Bis', lastName: 'Rules', pin: '8888', picks: p };
  assert.equal((await call(picks, { body: { ...base, bisPicks: [p.toy[0]] } })).status, 400, 'only 1 call');
  assert.equal((await call(picks, { body: { ...base, bisPick: p.toy[0] } })).status, 400, 'old single-call client');
  assert.equal((await call(picks, { body: { ...base, bisPicks: [p.toy[0], p.toy[0], p.hound[0]] } })).status, 400, 'duplicate');
  assert.equal((await call(picks, { body: { ...base, bisPicks: [p.toy[0], p.hound[0], 'not-a-dog'] } })).status, 400, 'not mine');
  const ok = await call(picks, { body: { ...base, bisPicks: bis(p) } });
  assert.equal(ok.status, 201);
  const loaded = await call(picks, { body: { action: 'load', firstName: 'Bis', lastName: 'Rules', pin: '8888' } });
  assert.deepEqual(loaded.body.bisPicks, bis(p), 'order is kept');
  await pg.query("DELETE FROM players WHERE name_key = 'bis rules'");
});
await test('entries saved before multiple calls: single call still loads and scores', async () => {
  const p = makePicks();
  await call(picks, { body: { action: 'save', firstName: 'Old', lastName: 'Timer', pin: '4444', picks: p, bisPicks: bis(p) } });
  // Simulate a row from the old version: only bis_pick, no bis_picks
  await pg.query("UPDATE players SET bis_picks = NULL, bis_pick = $1 WHERE name_key = 'old timer'", [p.hound[0]]);
  const loaded = await call(picks, { body: { action: 'load', firstName: 'Old', lastName: 'Timer', pin: '4444' } });
  assert.deepEqual(loaded.body.bisPicks, [p.hound[0]]);
  const { loadPlayers } = await import('../lib/game.js');
  const me = (await loadPlayers()).find((x) => x.name === 'Old Timer');
  assert.deepEqual(me.bisPicks, [p.hound[0]]);
  assert.equal(scorePlayers([me], { 'hound:1': p.hound[0], BIS: p.hound[0] }).players[0].bisCorrect, true);
  // ...and they can edit to add the new calls
  const edited = await call(picks, { body: { action: 'save', firstName: 'Old', lastName: 'Timer', pin: '4444', picks: p, bisPicks: [p.hound[0], p.toy[1], p.herding[0]] } });
  assert.equal(edited.status, 200);
  await pg.query("DELETE FROM players WHERE name_key = 'old timer'");
});
await test('any of the 3 calls earns the bonus, once', () => {
  const r = scorePlayers([{ id: 1, name: 'A', picks: { toy: ['p', 'q', 'r'] }, bisPicks: ['q', 'p', 'r'], createdAt: '1' }], { 'toy:1': 'p', BIS: 'p' });
  // p picked by 1 player (underdog x2): (6 + 15) * 2 = 42, plus one +10 bonus
  assert.equal(r.players[0].total, 52);
});

await test('honeypot field rejects bots', async () => {
  const p = makePicks();
  const r = await call(picks, { body: { action: 'save', firstName: 'Bot', lastName: 'Net', pin: '1212', picks: p, bisPicks: bis(p), hp: 'http://spam.example' } });
  assert.equal(r.status, 400);
  const ok = await call(picks, { body: { action: 'save', firstName: 'Real', lastName: 'Person', pin: '1212', picks: p, bisPicks: bis(p), hp: '' } });
  assert.equal(ok.status, 201, 'empty honeypot is fine');
  await pg.query("DELETE FROM players WHERE name_key = 'real person'");
});
await test('new entries are limited per IP (edits are not)', async () => {
  const { LIMITS } = await import('../api/picks.js');
  const [max] = LIMITS.newEntriesPerIp;
  const p = makePicks();
  const ip = '203.0.113.77';
  const names = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor'.split(' ');
  let last;
  for (let i = 0; i <= max; i += 1) {
    last = await call(picks, { ip, body: { action: 'save', firstName: names[i], lastName: 'Party', pin: '3434', picks: p, bisPicks: bis(p) } });
    if (i < max) assert.equal(last.status, 201, `entry ${i + 1} should be allowed`);
  }
  assert.equal(last.status, 429, 'one past the limit is refused');
  // An existing player on the same Wi-Fi can still edit
  const edit = await call(picks, { ip, body: { action: 'save', firstName: names[0], lastName: 'Party', pin: '3434', picks: makePicks(3), bisPicks: bis(makePicks(3)) } });
  assert.equal(edit.status, 200);
  await pg.query("DELETE FROM players WHERE last_name = 'Party'");
  await pg.query("DELETE FROM rate_limits"); // don't let this test's counters affect later tests
});

await test('names: standard capitalization, deliberate capitals kept', async () => {
  const { formatName } = await import('../lib/game.js');
  const cases = [
    ['sam carn', 'Sam Carn'], ['SAM', 'Sam'], ["o'brien", "O'Brien"], ['mary-kate', 'Mary-Kate'],
    ['McDonald', 'McDonald'], ['DeShawn', 'DeShawn'], ['jean luc', 'Jean Luc'], ['élodie', 'Élodie'], ['j', 'J'],
  ];
  for (const [input, want] of cases) assert.equal(formatName(input), want, input);
  const p = makePicks();
  const r = await call(picks, { body: { action: 'save', firstName: 'sam', lastName: 'CARN', pin: '2468', picks: p, bisPicks: bis(p) } });
  assert.equal(r.status, 201);
  const row = (await pg.query("SELECT first_name, last_name FROM players WHERE name_key = 'sam carn'")).rows[0];
  assert.deepEqual([row.first_name, row.last_name], ['Sam', 'Carn'], 'stored capitalized');
  // An older entry saved as typed still displays capitalized
  await pg.query("UPDATE players SET first_name = 'sam', last_name = 'carn' WHERE name_key = 'sam carn'");
  const st = await call(state, { method: 'GET' });
  assert.ok(st.body.leaderboard.some((x) => x.name === 'Sam Carn'));
  // Same person typing a different case still edits the same entry
  const again = await call(picks, { body: { action: 'save', firstName: 'SAM', lastName: 'carn', pin: '2468', picks: p, bisPicks: bis(p) } });
  assert.equal(again.status, 200);
  await pg.query("DELETE FROM players WHERE name_key = 'sam carn'");
});

console.log('Sign-in tests');
const auth = (await import('../api/auth.js')).default;
const { setTestGoogleKeys } = await import('../lib/google.js');
const nodeCrypto = await import('node:crypto');
const CLIENT = 'test-client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = CLIENT;
const realKey = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const evilKey = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
setTestGoogleKeys([{ ...realKey.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }]);
/** Make a Google-style ID token. Overrides let tests forge bad ones. */
function gToken(claims = {}, { key = realKey.privateKey, kid = 'k1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1111', iat: now, exp: now + 3600, given_name: 'Gina', family_name: 'Google', email: 'g@example.com', ...claims });
  const sig = nodeCrypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const sessionOf = (r) => (String(r.headers['set-cookie'] || '').match(/dd_session=[^;]+/) || [null])[0];
const deviceOf = (r) => (String(r.headers['set-cookie'] || '').match(/dd_device=[^;]+/) || [null])[0];

await test('signed out: GET reports config only', async () => {
  const r = await call(auth, { method: 'GET' });
  assert.equal(r.body.signedIn, false);
  assert.equal(r.body.googleClientId, CLIENT);
  assert.equal(r.body.player, null);
});
await test('PIN sign-up creates an empty entry, stays signed in, saves via session', async () => {
  const r = await call(auth, { body: { action: 'pin', firstName: 'pat', lastName: 'new', pin: '1357', hp: '' } });
  assert.equal(r.status, 201);
  const sess = sessionOf(r);
  assert.ok(sess, 'session cookie set');
  assert.match(String(r.headers['set-cookie']), /dd_session=[^;]+; Path=\/api; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000/);
  assert.equal(r.body.player.name, 'Pat New');
  const before = await call(state, { method: 'GET' });
  assert.ok(!before.body.leaderboard.some((x) => x.name === 'Pat New'), 'not in the game until picks are saved');
  const me = await call(auth, { method: 'GET', cookie: sess });
  assert.equal(me.body.signedIn, true);
  const p = makePicks();
  const save = await call(picks, { cookie: sess, body: { action: 'save', picks: p, bisPicks: bis(p) } });
  assert.equal(save.status, 200);
  const load = await call(picks, { cookie: sess, body: { action: 'load' } });
  assert.deepEqual(load.body.bisPicks, bis(p));
  const after = await call(state, { method: 'GET' });
  assert.ok(after.body.leaderboard.some((x) => x.name === 'Pat New'));
  await pg.query("DELETE FROM players WHERE name_key = 'pat new'");
});
await test('PIN sign-in to an existing entry: right PIN only', async () => {
  const wrong = await call(auth, { body: { action: 'pin', firstName: 'Ann', lastName: 'Lee', pin: '0000' } });
  assert.equal(wrong.status, 403);
  await pg.query('DELETE FROM rate_limits');
  const ok = await call(auth, { body: { action: 'pin', firstName: 'ann', lastName: 'lee', pin: '1234' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.created, false);
  assert.ok(ok.body.player.picks.toy.length === 3, 'existing picks come back');
});
await test('forged, tampered, or expired session cookies are ignored', async () => {
  const ok = await call(auth, { body: { action: 'pin', firstName: 'Ann', lastName: 'Lee', pin: '1234' } });
  const sess = sessionOf(ok);
  const [name, val] = sess.split('=');
  const [v, id, exp, sig] = val.split('.');
  for (const bad of [`${v}.${Number(id) + 1}.${exp}.${sig}`, `${v}.${id}.${Number(exp) + 1}.${sig}`, `${v}.${id}.${exp}.AAAA`, `${v}.${id}.1000.${sig}`, 'garbage']) {
    const r = await call(auth, { method: 'GET', cookie: `${name}=${bad}` });
    assert.equal(r.body.signedIn, false, bad);
  }
  const p = makePicks();
  const r = await call(picks, { cookie: `${name}=${v}.${Number(id) + 1}.${exp}.${sig}`, body: { action: 'save', picks: p, bisPicks: bis(p) } });
  assert.notEqual(r.status, 200, 'a tampered cookie cannot save');
});
await test('admin and player cookies cannot stand in for each other', async () => {
  const ok = await call(auth, { body: { action: 'pin', firstName: 'Ann', lastName: 'Lee', pin: '1234' } });
  const sess = sessionOf(ok);
  assert.equal((await call(admin, { method: 'GET', cookie: sess })).status, 401);
  const adminLogin = await call(admin, { body: { action: 'login', password: 'test-admin-password' } });
  const adminCookie = String(adminLogin.headers['set-cookie']).split(';')[0];
  const asPlayer = `dd_session=${adminCookie.split('=')[1]}`;
  assert.equal((await call(auth, { method: 'GET', cookie: asPlayer })).body.signedIn, false);
});
await test('Google: valid token asks "already entered?", then signs up, then signs in to the same entry', async () => {
  const ask = await call(auth, { body: { action: 'google', credential: gToken() } });
  assert.equal(ask.body.needsChoice, true, 'asks before creating');
  assert.equal(sessionOf(ask), null, 'not signed in yet');
  const r = await call(auth, { body: { action: 'google', credential: gToken(), confirmNew: true } });
  assert.equal(r.status, 201);
  assert.equal(r.body.player.name, 'Gina Google');
  assert.equal(r.body.player.google, true);
  assert.equal(r.body.player.hasPin, false);
  const again = await call(auth, { body: { action: 'google', credential: gToken() } });
  assert.equal(again.status, 200);
  assert.equal(again.body.player.id, r.body.player.id);
  const pinTry = await call(auth, { body: { action: 'pin', firstName: 'Gina', lastName: 'Google', pin: '1234' } });
  assert.equal(pinTry.status, 403);
  assert.match(pinTry.body.error, /signs in with Google/);
});
await test('Google: forged, wrong-site, expired, or wrong-issuer tokens are rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const bad = [
    gToken({}, { key: evilKey.privateKey }),            // signed by someone else
    gToken({ aud: 'other-site.apps.googleusercontent.com' }), // token for another site
    gToken({ exp: now - 3600 }),                          // expired
    gToken({ iss: 'https://evil.example' }),              // not Google
    gToken({}, { kid: 'unknown' }),                       // unknown key
    'not.a.token', '', 12345,
  ];
  for (const credential of bad) {
    const r = await call(auth, { body: { action: 'google', credential } });
    assert.equal(r.status, 401, String(credential).slice(0, 30));
  }
  // alg=none trick
  const t = gToken().split('.');
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${t[1]}.`;
  assert.equal((await call(auth, { body: { action: 'google', credential: none } })).status, 401);
});
await test('Google: same name as a PIN entry must link with that PIN', async () => {
  const tok = gToken({ sub: '2222', given_name: 'Ann', family_name: 'Lee' });
  const r = await call(auth, { body: { action: 'google', credential: tok } });
  assert.equal(r.body.needsLink, true);
  assert.equal(sessionOf(r), null, 'not signed in yet');
  const wrong = await call(auth, { body: { action: 'link', credential: tok, pin: '9999' } });
  assert.equal(wrong.status, 403);
  const ok = await call(auth, { body: { action: 'link', credential: tok, pin: '1234' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.player.name, 'Ann Lee');
  assert.equal(ok.body.player.google, true);
  const direct = await call(auth, { body: { action: 'google', credential: tok } });
  assert.equal(direct.body.player.name, 'Ann Lee', 'next time Google signs straight in');
  const other = await call(auth, { body: { action: 'google', credential: gToken({ sub: '3333', given_name: 'Ann', family_name: 'Lee' }) } });
  assert.equal(other.status, 409, "a different Google account can't take Ann's entry");
  await pg.query("UPDATE players SET google_sub = NULL WHERE name_key = 'ann lee'");
});
await test('Google name differs from the entry ("Samuel" vs "Sam"): connect by name + PIN, no second team', async () => {
  const sam = await call(auth, { body: { action: 'pin', firstName: 'Sam', lastName: 'Carn', pin: '7777' } });
  assert.equal(sam.status, 201);
  const tok = gToken({ sub: '7777', given_name: 'Samuel', family_name: 'Carn' });
  const ask = await call(auth, { body: { action: 'google', credential: tok } });
  assert.equal(ask.body.needsChoice, true);
  const wrong = await call(auth, { body: { action: 'link', credential: tok, firstName: 'Sam', lastName: 'Carn', pin: '0000' } });
  assert.equal(wrong.status, 403);
  const ok = await call(auth, { body: { action: 'link', credential: tok, firstName: 'sam', lastName: 'carn', pin: '7777' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.player.name, 'Sam Carn');
  const again = await call(auth, { body: { action: 'google', credential: tok } });
  assert.equal(again.body.player.name, 'Sam Carn', 'Google now signs straight in to Sam Carn');
  const n = (await pg.query("SELECT count(*)::int AS n FROM players WHERE last_name = 'Carn'")).rows[0].n;
  assert.equal(n, 1, 'still one team');
  await pg.query("DELETE FROM players WHERE name_key = 'sam carn'");
  await pg.query('DELETE FROM rate_limits');
});
await test('Google: missing last name asks for a name', async () => {
  const tok = gToken({ sub: '4444', given_name: 'Cher', family_name: '' });
  const r = await call(auth, { body: { action: 'google', credential: tok } });
  assert.equal(r.body.needsName, true);
  const named = await call(auth, { body: { action: 'google', credential: tok, firstName: 'Cher', lastName: 'Bono', confirmNew: true } });
  assert.equal(named.status, 201);
  assert.equal(named.body.player.name, 'Cher Bono');
  await pg.query("DELETE FROM players WHERE google_sub IN ('1111', '4444')");
});
await test('Google sign-up respects one entry per device', async () => {
  const pinUp = await call(auth, { body: { action: 'pin', firstName: 'Dev', lastName: 'One', pin: '2020' } });
  const dev = deviceOf(pinUp);
  const g = await call(auth, { cookie: dev, body: { action: 'google', credential: gToken({ sub: '5555', given_name: 'Dev', family_name: 'Two' }), confirmNew: true } });
  assert.equal(g.status, 409);
  assert.match(g.body.error, /already has an entry for Dev One/);
  await pg.query("DELETE FROM players WHERE name_key IN ('dev one', 'dev two')");
});
await test('logout clears the session cookie', async () => {
  const r = await call(auth, { body: { action: 'logout' } });
  assert.match(String(r.headers['set-cookie']), /dd_session=; .*Max-Age=0/);
});
await test('honeypot applies to sign-in too', async () => {
  const r = await call(auth, { body: { action: 'pin', firstName: 'Bot', lastName: 'Two', pin: '1111', hp: 'x' } });
  assert.equal(r.status, 400);
  await pg.query('DELETE FROM rate_limits');
});

// More players for scoring
const bob = { firstName: 'Bob', lastName: 'Ray', pin: '2222' };
const cat = { firstName: 'Cat', lastName: 'Kim', pin: '3333' };
await call(picks, { body: { action: 'save', ...bob, picks: makePicks(0), bisPicks: [makePicks(0).toy[0], makePicks(0).hound[0], makePicks(0).sporting[0]] } });
await call(picks, { body: { action: 'save', ...cat, picks: makePicks(0), bisPicks: [makePicks(0).hound[1], makePicks(0).toy[0], makePicks(0).sporting[0]] } });

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

await test('after lock: existing players can sign in, nobody new can join or save', async () => {
  const ok = await call(auth, { body: { action: 'pin', firstName: 'Bob', lastName: 'Ray', pin: '2222' } });
  assert.equal(ok.status, 200);
  const p = makePicks();
  const save = await call(picks, { cookie: sessionOf(ok), body: { action: 'save', picks: p, bisPicks: bis(p) } });
  assert.equal(save.status, 423);
  const late = await call(auth, { body: { action: 'pin', firstName: 'Late', lastName: 'Comer', pin: '3333' } });
  assert.equal(late.status, 423);
  const lateG = await call(auth, { body: { action: 'google', credential: gToken({ sub: '6666', given_name: 'Late', family_name: 'Google' }), confirmNew: true } });
  assert.equal(lateG.status, 423);
});
await test('saving after lock is refused', async () => {
  const p = makePicks();
  const r = await call(picks, { body: { action: 'save', ...bob, picks: p, bisPicks: bis(p) } });
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
  // Bob & Cat picked H[0..2]; Ann picked H[3..5]. H[0] picked by 2 -> NOT an underdog (solo only).
  await call(admin, { cookie, body: { action: 'reveal', slots: ['hound:2'] } });
  await call(admin, { cookie, body: { action: 'set', slot: 'BIS', breedId: H[0], reveal: true } });
  const r = await call(state, { method: 'GET' });
  const bobRow = r.body.leaderboard.find((p) => p.name === 'Bob Ray');
  const catRow = r.body.leaderboard.find((p) => p.name === 'Cat Kim');
  // H[0]: 6 + 15 = 21; H[1] 2nd: 3; Bob BIS call H[0] +10
  assert.equal(bobRow.total, 21 + 3 + 10);
  assert.equal(catRow.total, 21 + 3);
  assert.equal(bobRow.rank, 1);
  assert.equal(r.body.pickCounts[H[0]], 2);
  assert.ok(Array.isArray(bobRow.picks.hound));
});
await test('admin pick stats: counts per group, solo picks, BIS calls; admin only', async () => {
  const a = await call(admin, { method: 'GET', cookie });
  const st = a.body.pickStats;
  assert.equal(st.playerCount, 3);
  const hound = st.groups.find((g) => g.key === 'hound');
  assert.deepEqual(hound.breeds.slice(0, 3).map((x) => x.count), [2, 2, 2], 'Bob and Cat share H[0..2]');
  assert.equal(hound.underdogs, 3, "Ann's three hounds are solo picks");
  assert.equal(st.bisCalls.reduce((n, x) => n + x.count, 0), 9, '3 players x 3 calls');
  assert.ok(!JSON.stringify(st).includes('Bob'), 'no player names in stats');
  const pub = await call(state, { method: 'GET' });
  assert.equal(pub.body.pickStats, undefined, 'never in the public state');
  assert.equal((await call(admin, { method: 'GET' })).status, 401);
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
  const ours = BREEDS.filter((b) => ['plott-hound', 'pomeranian', 'keeshond', 'chinook', 'boerboel'].includes(b.id));
  const api = [fakeApi('Plott'), fakeApi('Pomeranian'), fakeApi('Some Spitz', { other: ['Wolfspitz'] }), fakeApi('Chinook', { noImages: true })];
  const { photos, debug } = fb.matchPhotos(ours, api);
  assert.equal(photos['plott-hound'].src, 'https://images.dogapi.dog/m/Plott.jpg');
  assert.ok(photos.pomeranian && photos.keeshond, 'alias + other_names match');
  assert.equal(photos.chinook, undefined);
  assert.match(debug.chinook, /no images/);
  assert.match(debug.boerboel, /no Dog API breed/);
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

await test('admin can reset a forgotten PIN; old PIN stops working, picks are kept', async () => {
  const savedLock = process.env.LOCK_AT;
  process.env.LOCK_AT = new Date(Date.now() + 3600e3).toISOString();
  try {
    const made = await call(auth, { body: { action: 'pin', firstName: 'Forgetful', lastName: 'Dad', pin: '1111' } });
    assert.equal(made.status, 201);
    const id = made.body.player.id;
    const p = makePicks();
    assert.equal((await call(picks, { cookie: sessionOf(made), body: { action: 'save', picks: p, bisPicks: bis(p) } })).status, 200);

    for (let i = 0; i < 10; i++) await call(auth, { body: { action: 'pin', firstName: 'Forgetful', lastName: 'Dad', pin: '9999' } });
    assert.equal((await call(auth, { body: { action: 'pin', firstName: 'Forgetful', lastName: 'Dad', pin: '1111' } })).status, 429, 'locked out from guessing');

    const notAdmin = await call(admin, { cookie: sessionOf(made), body: { action: 'resetPin', id, pin: '2222' } });
    assert.equal(notAdmin.status, 401, 'players cannot reset PINs');

    const login = await call(admin, { body: { action: 'login', password: 'test-admin-password' } });
    const adminCookie = String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await call(admin, { cookie: adminCookie, body: { action: 'resetPin', id, pin: '12a4' } })).status, 400);
    assert.equal((await call(admin, { cookie: adminCookie, body: { action: 'resetPin', id: 999999, pin: '2222' } })).status, 404);
    assert.equal((await call(admin, { cookie: adminCookie, body: { action: 'resetPin', id, pin: '2222' } })).status, 200);

    const oldPin = await call(auth, { body: { action: 'pin', firstName: 'Forgetful', lastName: 'Dad', pin: '1111' } });
    assert.equal(oldPin.status, 403, 'old PIN rejected');
    const newPin = await call(auth, { body: { action: 'pin', firstName: 'forgetful', lastName: 'dad', pin: '2222' } });
    assert.equal(newPin.status, 200, 'new PIN works');
    assert.equal(newPin.body.player.id, id, 'same entry');
    assert.deepEqual(newPin.body.player.picks, p, 'picks kept');
  } finally {
    process.env.LOCK_AT = savedLock;
  }
});

console.log('\nBotID');
const botid = await import('../lib/botid.js');

await test('requests flagged as bots are refused on sign-in and picks, but sign-out still works', async () => {
  botid.setTestBotCheck(() => true);
  try {
    const signIn = await call(auth, { body: { action: 'pin', firstName: 'Bot', lastName: 'Net', pin: '1234', hp: '' } });
    assert.equal(signIn.status, 403);
    assert.equal(signIn.body.error, botid.BOT_BLOCKED_MESSAGE);
    const load = await call(picks, { body: { action: 'load', firstName: 'Bot', lastName: 'Net', pin: '1234', hp: '' } });
    assert.equal(load.status, 403);
    const out = await call(auth, { body: { action: 'logout' } });
    assert.equal(out.status, 200);
  } finally {
    botid.setTestBotCheck(null);
  }
});

await test('humans pass the bot check', async () => {
  const savedLock = process.env.LOCK_AT;
  process.env.LOCK_AT = new Date(Date.now() + 3600e3).toISOString(); // earlier tests lock the game
  botid.setTestBotCheck(() => false);
  try {
    const r = await call(auth, { body: { action: 'pin', firstName: 'Real', lastName: 'Person', pin: '2468', hp: '' } });
    assert.equal(r.status, 201); // new entry created
  } finally {
    botid.setTestBotCheck(null);
    process.env.LOCK_AT = savedLock;
  }
});

await test('a BotID outage lets people through instead of locking everyone out', async () => {
  // Pretend to be on Vercel in production with no OIDC token: the real
  // botid library throws, and requireHuman must allow the request.
  const saved = { VERCEL: process.env.VERCEL, NODE_ENV: process.env.NODE_ENV, VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN };
  const quiet = console.error;
  let logged = '';
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'production';
  delete process.env.VERCEL_OIDC_TOKEN;
  console.error = (...a) => { logged += a.join(' '); };
  try {
    await botid.requireHuman({ headers: { host: 'dogdraft.test' } }, 'test');
    assert.match(logged, /check failed, allowing request/);
  } finally {
    console.error = quiet;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

await test('BOTID_DISABLED=1 turns the check off', async () => {
  const saved = process.env.VERCEL;
  process.env.VERCEL = '1';
  process.env.BOTID_DISABLED = '1';
  try {
    await botid.requireHuman({ headers: {} }, 'test'); // would call Vercel otherwise
  } finally {
    delete process.env.BOTID_DISABLED;
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  }
});

await test('browser script is built, current, and loads before the app', async () => {
  const fs = await import('node:fs');
  const built = fs.readFileSync(new URL('../public/botid.js', import.meta.url), 'utf8');
  const version = JSON.parse(fs.readFileSync(new URL('../node_modules/botid/package.json', import.meta.url), 'utf8')).version;
  assert.ok(built.includes(`BotID client ${version}`), 'public/botid.js is stale: run npm run build:botid');
  for (const r of botid.BOTID_PROTECTED) assert.ok(built.includes(`"${r.path}"`), `browser script does not protect ${r.path}`);
  assert.ok(!built.includes('process.env'), 'browser script still references process.env');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const b = html.indexOf('src="/botid.js"');
  const a = html.indexOf('src="/app.js"');
  assert.ok(b !== -1 && b < a, 'index.html must load /botid.js before /app.js');
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
