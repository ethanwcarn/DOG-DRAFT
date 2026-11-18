/**
 * Fantasy Dog Draft - player-facing app.
 *
 * Data flow:
 *   /api/breeds  once at startup (catalog + scoring rules)
 *   /api/state   polled every 5s (lock status, revealed results, leaderboard)
 *   /api/picks   load/save the player's entry
 *
 * When a poll shows a result that was not there before, it is queued as a
 * celebration (overlay for winners, toast for 2nd-4th) and played in order.
 */
import { h, clear, store, api } from './dom.js';
import { confetti, showAward, toast, floatPoints, flip, onImgError } from './fx.js';
import { initPhotos, photoSrc, photoAttrs } from './photos.js';

const POLL_MS = 5000;
const POLL_HIDDEN_MS = 30000;
const POLL_ERROR_MS = 10000;

const app = {
  groups: [],
  groupByKey: new Map(),
  breeds: [],
  byId: new Map(),
  rules: null,
  server: null, // last /api/state response
  prevResults: null, // results seen on the previous poll (null = first load)
  lockedRendered: null, // which lock state the picks tab was last drawn for
  boardSig: '',
  resultsSig: '',
  expanded: new Set(),
  queue: [],
  playing: false,
  draft: store.get('dd_draft', { first: '', last: '', picks: {}, bisPick: null }),
  me: store.get('dd_me', null), // { first, last } after a successful save
  filter: '',
};

const imgSrc = (id) => photoSrc(id);
const meName = () => (app.me ? `${app.me.first} ${app.me.last}`.toLowerCase() : null);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function init() {
  setupTabs();
  try {
    const data = await api('/api/breeds');
    app.groups = data.groups;
    app.groupByKey = new Map(data.groups.map((g) => [g.key, g]));
    app.breeds = data.breeds;
    app.byId = new Map(data.breeds.map((b) => [b.id, b]));
    app.rules = data.rules;
    initPhotos(data.breeds);
    for (const g of app.groups) if (!Array.isArray(app.draft.picks[g.key])) app.draft.picks[g.key] = [];
    sanitizeDraft();
  } catch (e) {
    clear(document.getElementById('tab-picks')).append(h('p', { class: 'error-box' }, `Could not load the breed list. ${e.message}`));
    return;
  }
  renderRules();
  poll();
  setInterval(updateLockPill, 1000);
}

/** Drop anything in a saved draft that no longer matches the catalog. */
function sanitizeDraft() {
  for (const g of app.groups) {
    app.draft.picks[g.key] = app.draft.picks[g.key]
      .filter((id) => app.byId.get(id)?.group === g.key)
      .slice(0, app.rules.picksPerGroup);
  }
  if (!allPicks().includes(app.draft.bisPick)) app.draft.bisPick = null;
}

const allPicks = () => app.groups.flatMap((g) => app.draft.picks[g.key] || []);

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
async function poll() {
  let wait = document.hidden ? POLL_HIDDEN_MS : POLL_MS;
  try {
    const s = await api('/api/state', { timeoutMs: 8000 });
    s.clockOffset = Date.parse(s.serverTime) - Date.now();
    app.server = s;
    detectNewResults(s.results);
    render();
  } catch (e) {
    wait = POLL_ERROR_MS;
    const pill = document.getElementById('lock-pill');
    pill.textContent = e.status === 503 ? 'Setup not finished' : 'Reconnecting...';
    pill.className = 'lock-pill warn';
    if (!app.server) {
      clear(document.getElementById('tab-picks')).append(
        h('p', { class: 'error-box' }, e.status === 503 ? e.message : `Could not reach the game server. ${e.message}`),
      );
    }
  }
  setTimeout(poll, wait);
}
function render() {
  updateLockPill();
  if (app.lockedRendered !== app.server.locked) {
    app.lockedRendered = app.server.locked;
    renderPicks();
  } else if (app.server.locked) {
    renderMyTeam(); // scores change during the show
  }
  renderBoard();
  renderResults();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function setupTabs() {
  const go = (name) => {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
    document.getElementById('save-bar').hidden = !(name === 'picks' && app.server && !app.server.locked);
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  };
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go(a.dataset.goto);
      window.scrollTo({ top: 0 });
    }),
  );
  const initial = location.hash.slice(1);
  go(['picks', 'board', 'results', 'rules'].includes(initial) ? initial : 'picks');
  app.goTab = go;
}

// ---------------------------------------------------------------------------
// Lock countdown
// ---------------------------------------------------------------------------
function updateLockPill() {
  const s = app.server;
  if (!s) return;
  const pill = document.getElementById('lock-pill');
  const now = Date.now() + (s.clockOffset || 0);
  const ms = Date.parse(s.lockAt) - now;
  if (s.locked || ms <= 0) {
    pill.textContent = 'Picks locked. Enjoy the show!';
    pill.className = 'lock-pill live';
    // The server is the source of truth; refresh soon after the deadline passes.
    if (!s.locked && ms <= 0 && !app.lockRefresh) {
      app.lockRefresh = setTimeout(() => location.reload(), 3000);
    }
    return;
  }
  const d = Math.floor(ms / 86400000);
  const hr = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const when = new Date(s.lockAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  pill.textContent = d > 0 ? `Picks lock in ${d}d ${hr}h ${m}m (${when})` : `Picks lock in ${hr}h ${m}m ${sec}s`;
  pill.className = ms < 3600000 ? 'lock-pill soon' : 'lock-pill';
}

// ---------------------------------------------------------------------------
// My Picks tab
// ---------------------------------------------------------------------------
function renderPicks() {
  const root = clear(document.getElementById('tab-picks'));
  const locked = app.server.locked;
  const activeTab = document.querySelector('.tab[aria-selected="true"]')?.dataset.tab;
  document.getElementById('save-bar').hidden = locked || activeTab !== 'picks';

  if (locked) {
    root.append(
      h('div', { class: 'card intro' },
        h('h2', {}, 'Picks are locked'),
        h('p', {}, 'The show has started. Watch the Leaderboard and Results tabs. Points appear here as your breeds win.'),
      ),
      h('div', { id: 'my-team' }),
    );
    renderMyTeam();
    return;
  }

  const ppg = app.rules.picksPerGroup;
  const total = ppg * app.groups.length;

  // Step 1: identity
  const first = h('input', { id: 'in-first', autocomplete: 'given-name', maxlength: 30, value: app.draft.first || '', oninput: saveIdentity });
  const last = h('input', { id: 'in-last', autocomplete: 'family-name', maxlength: 30, value: app.draft.last || '', oninput: saveIdentity });
  const pin = h('input', { id: 'in-pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]{4}', maxlength: 4, autocomplete: 'off' });
  root.append(
    h('div', { class: 'card intro' },
      h('h2', {}, `Pick ${ppg} breeds from each of the 7 groups`),
      h('p', {}, 'Your breeds earn points when they place in their group or win Best in Show on the Thanksgiving broadcast. No dog knowledge needed: go with the photos!'),
    ),
    h('div', { class: 'card step' },
      h('h3', {}, h('span', { class: 'step-num' }, '1'), 'Who are you?'),
      h('div', { class: 'fields' },
        h('label', {}, 'First name', first),
        h('label', {}, 'Last name', last),
        h('label', {}, '4-digit PIN', pin, h('small', {}, 'Make one up. You need it to change your picks later.')),
      ),
      h('p', { class: 'muted' }, 'Already entered? Type your name and PIN, then ',
        h('button', { class: 'linklike', type: 'button', onclick: loadMyPicks }, 'load my saved picks'), '.'),
    ),
  );

  // Step 2: the breed grid
  const search = h('input', {
    type: 'search', placeholder: 'Search breeds (try "fluffy" or "corgi")', value: app.filter, 'aria-label': 'Search breeds',
    oninput: (e) => { app.filter = e.target.value; applyFilter(); },
  });
  root.append(h('div', { class: 'card step sticky-search' },
    h('h3', {}, h('span', { class: 'step-num' }, '2'), `Choose your ${total} dogs`),
    search,
  ));

  for (const g of app.groups) {
    const breeds = app.breeds.filter((b) => b.group === g.key);
    root.append(
      h('section', { class: 'group', id: `group-${g.key}`, style: { '--accent': g.color } },
        h('div', { class: 'group-head' },
          h('h3', {}, `${g.name} Group`),
          h('span', { class: 'counter', id: `count-${g.key}` }, ''),
        ),
        h('div', { class: 'breed-grid' }, breeds.map((b) => breedCard(b))),
        h('p', { class: 'no-match muted', hidden: true }, 'No breeds match your search in this group.'),
      ),
    );
  }

  // Step 3: Best in Show call
  root.append(h('div', { class: 'card step', id: 'bis-step' },
    h('h3', {}, h('span', { class: 'step-num' }, '3'), 'Your Best in Show call'),
    h('p', { class: 'muted' }, `Pick one of your dogs to win it all. Bonus +${app.rules.points.bestInShowCallBonus} points if you are right.`),
    h('div', { class: 'chips', id: 'bis-chips' }),
  ));

  document.getElementById('save-btn').onclick = savePicks;
  refreshSelection();
  applyFilter();
}

function breedCard(b) {
  return h('button', {
    class: 'breed', type: 'button', dataset: { id: b.id, search: `${b.name} ${b.blurb}`.toLowerCase() },
    'aria-pressed': 'false', onclick: () => toggle(b),
  },
  h('img', { ...photoAttrs(b.id), alt: '', loading: 'lazy', decoding: 'async', onerror: onImgError }),
  h('span', { class: 'check', 'aria-hidden': 'true' }),
  h('span', { class: 'breed-name' }, b.name),
  h('span', { class: 'breed-blurb' }, b.blurb));
}

function saveIdentity() {
  app.draft.first = document.getElementById('in-first').value;
  app.draft.last = document.getElementById('in-last').value;
  store.set('dd_draft', app.draft);
}

function toggle(b) {
  const list = app.draft.picks[b.group];
  const i = list.indexOf(b.id);
  if (i >= 0) {
    list.splice(i, 1);
    if (app.draft.bisPick === b.id) app.draft.bisPick = null;
  } else if (list.length >= app.rules.picksPerGroup) {
    toast(`You already have ${app.rules.picksPerGroup} ${app.groupByKey.get(b.group).name} dogs. Tap one to remove it first.`, { kind: 'warn' });
    return;
  } else {
    list.push(b.id);
  }
  store.set('dd_draft', app.draft);
  refreshSelection();
}

/** Update card states, counters, BIS chips, and the save bar without a full re-render. */
function refreshSelection() {
  const ppg = app.rules.picksPerGroup;
  const picked = new Set(allPicks());
  document.querySelectorAll('#tab-picks .breed').forEach((el) => {
    const on = picked.has(el.dataset.id);
    el.setAttribute('aria-pressed', String(on));
    const full = app.draft.picks[app.byId.get(el.dataset.id).group].length >= ppg;
    el.classList.toggle('dim', !on && full);
  });
  for (const g of app.groups) {
    const n = app.draft.picks[g.key].length;
    const c = document.getElementById(`count-${g.key}`);
    if (c) {
      c.textContent = `${n} of ${ppg}`;
      c.classList.toggle('done', n === ppg);
    }
  }
  const chips = document.getElementById('bis-chips');
  if (chips) {
    clear(chips);
    const ids = allPicks();
    if (!ids.length) chips.append(h('p', { class: 'muted' }, 'Your picks will show up here.'));
    for (const id of ids) {
      const b = app.byId.get(id);
      chips.append(h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(app.draft.bisPick === id),
        onclick: () => { app.draft.bisPick = id; store.set('dd_draft', app.draft); refreshSelection(); },
      }, h('img', { ...photoAttrs(id), alt: '', loading: 'lazy', onerror: onImgError }), b.name));
    }
  }
  const total = ppg * app.groups.length;
  const progress = document.getElementById('save-progress');
  progress.textContent = `${picked.size} of ${total} picked${app.draft.bisPick ? ' + Best in Show call' : ''}`;
}

function applyFilter() {
  const q = app.filter.trim().toLowerCase();
  document.querySelectorAll('#tab-picks .group').forEach((sec) => {
    let shown = 0;
    sec.querySelectorAll('.breed').forEach((el) => {
      const match = !q || el.dataset.search.includes(q);
      el.hidden = !match;
      if (match) shown += 1;
    });
    sec.querySelector('.no-match').hidden = shown > 0;
  });
}

function readIdentity() {
  const first = document.getElementById('in-first').value.trim();
  const last = document.getElementById('in-last').value.trim();
  const pin = document.getElementById('in-pin').value.trim();
  if (!first || !last) throw new Error('Please enter your first and last name (step 1).');
  if (!/^\d{4}$/.test(pin)) throw new Error('Please enter a 4-digit PIN (step 1).');
  return { first, last, pin };
}

async function loadMyPicks() {
  try {
    const { first, last, pin } = readIdentity();
    const data = await api('/api/picks', { method: 'POST', body: { action: 'load', firstName: first, lastName: last, pin } });
    app.draft = { first, last, picks: data.picks, bisPick: data.bisPick };
    sanitizeDraft();
    store.set('dd_draft', app.draft);
    app.me = { first, last };
    store.set('dd_me', app.me);
    refreshSelection();
    toast('Loaded your picks. Make changes and save again.', { kind: 'ok' });
  } catch (e) {
    toast(e.message, { kind: 'error', ms: 5000 });
    if (/step 1/.test(e.message)) document.getElementById('in-first').focus();
  }
}

async function savePicks() {
  const btn = document.getElementById('save-btn');
  try {
    const { first, last, pin } = readIdentity();
    const ppg = app.rules.picksPerGroup;
    const missing = app.groups.filter((g) => app.draft.picks[g.key].length !== ppg);
    if (missing.length) {
      document.getElementById(`group-${missing[0].key}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      throw new Error(`Pick ${ppg} in every group. Still need: ${missing.map((g) => g.name).join(', ')}.`);
    }
    if (!app.draft.bisPick) {
      document.getElementById('bis-step').scrollIntoView({ behavior: 'smooth', block: 'center' });
      throw new Error('Choose your Best in Show call (step 3).');
    }
    btn.disabled = true;
    btn.textContent = 'Saving...';
    const r = await api('/api/picks', {
      method: 'POST',
      body: { action: 'save', firstName: first, lastName: last, pin, picks: app.draft.picks, bisPick: app.draft.bisPick },
    });
    app.me = { first, last };
    store.set('dd_me', app.me);
    confetti(['#F5C542', '#2E7D32', '#1565C0', '#C62828'], 90, { y: 0.8, spread: Math.PI / 2 });
    toast(r.created ? 'You are in! Come back on Thanksgiving to watch your dogs score.' : 'Your picks were updated.', { kind: 'ok', ms: 5000 });
  } catch (e) {
    toast(e.message, { kind: 'error', ms: 6000 });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save my picks';
  }
}

/** After lock: show the current player's team with points. */
function renderMyTeam() {
  const box = document.getElementById('my-team');
  if (!box) return;
  clear(box);
  const me = app.server.leaderboard.find((p) => p.name.toLowerCase() === meName());
  if (!me) {
    box.append(h('p', { class: 'card muted' }, 'Find your team on the Leaderboard tab (tap your name).'));
    return;
  }
  box.append(h('div', { class: 'card' },
    h('h3', {}, `Your team: ${me.total} pts (#${me.rank})`),
    teamDetail(me),
  ));
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
function renderBoard({ animate = true } = {}) {
  const s = app.server;
  const sig = JSON.stringify([s.locked, s.leaderboard.map((p) => [p.id, p.total, p.rank]), [...app.expanded], meName()]);
  if (sig === app.boardSig) return;
  app.boardSig = sig;

  const root = document.getElementById('tab-board');
  // Only slide rows when standings change, not when someone expands a row.
  const done = animate ? flip(root) : () => {};
  clear(root);

  if (!s.locked) {
    root.append(
      h('div', { class: 'card intro' },
        h('h2', {}, `${s.playerCount} ${s.playerCount === 1 ? 'player is' : 'players are'} in`),
        h('p', { class: 'muted' }, 'Everyone\'s picks stay secret until the show starts. Then this becomes the live leaderboard.'),
      ),
      h('ul', { class: 'roster' }, s.leaderboard.map((p) =>
        h('li', { class: p.name.toLowerCase() === meName() ? 'is-me' : '' }, p.name))),
    );
    return;
  }

  if (!s.leaderboard.length) {
    root.append(h('p', { class: 'card muted' }, 'Nobody entered picks.'));
    return;
  }

  const list = h('ol', { class: 'board' });
  for (const p of s.leaderboard) {
    const isMe = p.name.toLowerCase() === meName();
    const open = app.expanded.has(p.id);
    const scoring = p.breakdown.slice(0, 6);
    list.append(h('li', { class: `row ${isMe ? 'is-me' : ''}`, 'data-key': `p${p.id}`, id: `row-${p.id}` },
      h('button', {
        class: 'row-main', type: 'button', 'aria-expanded': String(open),
        onclick: () => { open ? app.expanded.delete(p.id) : app.expanded.add(p.id); renderBoard({ animate: false }); },
      },
      h('span', { class: 'rank' }, `#${p.rank}`),
      h('span', { class: 'who' }, p.name, isMe ? h('span', { class: 'badge' }, 'You') : null),
      h('span', { class: 'scorers' }, scoring.map((x) =>
        h('img', { ...photoAttrs(x.breedId), alt: app.byId.get(x.breedId)?.name || '', title: app.byId.get(x.breedId)?.name || '', onerror: onImgError }))),
      h('span', { class: 'pts' }, `${p.total}`, h('small', {}, ' pts'))),
      open ? teamDetail(p) : null,
    ));
  }
  root.append(list);
  done();
}

/** A player's 21 picks grouped by group, with points earned. */
function teamDetail(p) {
  const counts = app.server.pickCounts || {};
  const earned = new Map(p.breakdown.map((x) => [x.breedId, x]));
  return h('div', { class: 'team' },
    app.groups.map((g) => h('div', { class: 'team-group', style: { '--accent': g.color } },
      h('h4', {}, g.name),
      h('ul', {}, (p.picks[g.key] || []).map((id) => {
        const b = app.byId.get(id);
        const e = earned.get(id);
        const underdog = (counts[id] || 0) <= app.rules.underdogMaxPickers;
        return h('li', { class: e ? 'scored' : '' },
          h('img', { ...photoAttrs(id), alt: '', loading: 'lazy', onerror: onImgError }),
          h('span', { class: 'tn' }, b ? b.name : id,
            p.bisPick === id ? h('span', { class: 'tag gold' }, 'BIS call') : null,
            underdog ? h('span', { class: 'tag' }, 'Underdog x2') : null),
          h('span', { class: 'tp' }, e ? `+${e.points}` : ''));
      })),
    )),
    p.bisCorrect ? h('p', { class: 'bonus' }, `Best in Show call correct: +${app.rules.points.bestInShowCallBonus}`) : null,
  );
}

// ---------------------------------------------------------------------------
// Results tab
// ---------------------------------------------------------------------------
function renderResults() {
  const s = app.server;
  const sig = JSON.stringify([s.results, s.pickCounts]);
  if (sig === app.resultsSig) return;
  app.resultsSig = sig;
  const root = clear(document.getElementById('tab-results'));
  const r = s.results;
  const counts = s.pickCounts || {};
  const pickedBy = (id) => (s.locked ? `Picked by ${counts[id] || 0}` : '');

  const top = (slot, label, cls) => {
    const id = r[slot];
    const b = id && app.byId.get(id);
    return h('div', { class: `card top-award ${cls}` },
      h('p', { class: 'award-kicker' }, label),
      b ? [h('img', { ...photoAttrs(id), alt: b.name, onerror: onImgError }), h('h3', {}, b.name), h('p', { class: 'muted' }, pickedBy(id))]
        : h('p', { class: 'muted' }, 'Not announced yet'));
  };
  root.append(h('div', { class: 'top-awards' }, top('BIS', 'Best in Show', 'gold'), top('RBIS', 'Reserve Best in Show', 'silver')));

  const places = ['Winner', '2nd', '3rd', '4th'];
  root.append(h('div', { class: 'results-grid' }, app.groups.map((g) =>
    h('div', { class: 'card group-result', style: { '--accent': g.color } },
      h('h3', {}, `${g.name} Group`),
      h('ol', {}, [1, 2, 3, 4].map((place) => {
        const id = r[`${g.key}:${place}`];
        const b = id && app.byId.get(id);
        if (!b && place > 1) return null; // optional placements: just hide when not entered
        return h('li', { class: place === 1 ? 'first' : '' },
          h('span', { class: 'place' }, places[place - 1]),
          b ? [h('img', { ...photoAttrs(id), alt: '', onerror: onImgError }), h('span', {}, b.name), h('small', { class: 'muted' }, pickedBy(id))]
            : h('span', { class: 'muted' }, 'Not announced yet'));
      })),
    ))));
}

// ---------------------------------------------------------------------------
// New result detection and celebration queue
// ---------------------------------------------------------------------------
const SLOT_ORDER = (slot) => {
  if (slot === 'BIS') return 1000;
  if (slot === 'RBIS') return 900;
  const [g, p] = slot.split(':');
  return app.groups.findIndex((x) => x.key === g) * 10 + (5 - Number(p)); // 4th, 3rd, 2nd, then winner
};

function detectNewResults(results) {
  if (app.prevResults === null) {
    app.prevResults = { ...results }; // first load: no replays of old news
    return;
  }
  const fresh = Object.keys(results)
    .filter((slot) => results[slot] !== app.prevResults[slot])
    .sort((a, b) => SLOT_ORDER(a) - SLOT_ORDER(b));
  app.prevResults = { ...results };
  for (const slot of fresh) app.queue.push({ slot, breedId: results[slot] });
  playQueue();
}

async function playQueue() {
  if (app.playing) return;
  app.playing = true;
  try {
    while (app.queue.length) {
      await celebrate(app.queue.shift());
    }
  } finally {
    app.playing = false;
  }
}

async function celebrate({ slot, breedId }) {
  const b = app.byId.get(breedId);
  if (!b) return;
  const s = app.server;
  const pts = app.rules.points;
  const g = app.groupByKey.get(b.group);
  const place = slot.includes(':') ? Number(slot.split(':')[1]) : null;
  const base = slot === 'BIS' ? pts.bestInShow : slot === 'RBIS' ? pts.reserveBestInShow : pts.place[place];

  // Who picked it (only known after the lock)
  const pickers = s.locked ? s.leaderboard.filter((p) => Object.values(p.picks || {}).some((ids) => ids.includes(breedId))) : [];
  const underdog = pickers.length > 0 && pickers.length <= app.rules.underdogMaxPickers;
  const each = underdog ? base * 2 : base;
  const lines = [];
  if (s.locked) {
    if (!pickers.length) lines.push(`Nobody picked this one! (+${base} would have been on the table)`);
    else {
      lines.push(`${underdog ? 'Underdog bonus! ' : ''}+${each} points for ${pickers.length === 1 ? 'its 1 picker' : `each of its ${pickers.length} pickers`}`);
      lines.push(pickers.slice(0, 8).map((p) => p.name).join(', ') + (pickers.length > 8 ? ` and ${pickers.length - 8} more` : ''));
    }
  } else {
    lines.push(`Worth ${base} points`);
  }
  const mine = pickers.find((p) => p.name.toLowerCase() === meName());
  const bisCall = slot === 'BIS' && mine && mine.bisPick === breedId;
  const youLine = mine ? `You picked it! +${each + (bisCall ? pts.bestInShowCallBonus : 0)} for you${bisCall ? ' (including your Best in Show call bonus)' : ''}` : null;

  if (mine) floatPoints(document.getElementById(`row-${mine.id}`), `+${each}`);

  if (place && place > 1) {
    await toast(`${g.name} Group ${['', '', '2nd', '3rd', '4th'][place]}: ${b.name} (+${base}${underdog ? ' x2' : ''})${mine ? '. That is yours!' : ''}`, { color: g.color, ms: 4000 });
    return;
  }
  await showAward({
    kind: slot === 'BIS' ? 'bis' : slot === 'RBIS' ? 'reserve' : 'group',
    title: slot === 'BIS' ? 'Best in Show!' : slot === 'RBIS' ? 'Reserve Best in Show' : `${g.name} Group Winner`,
    breed: b,
    imgSrc: imgSrc(breedId),
    color: g.color,
    lines,
    youLine,
  });
}

// ---------------------------------------------------------------------------
// How to Play tab
// ---------------------------------------------------------------------------
function renderRules() {
  const p = app.rules.points;
  const root = clear(document.getElementById('tab-rules'));
  root.append(
    h('div', { class: 'card' },
      h('h2', {}, 'How to play'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Enter your first and last name and make up a 4-digit PIN.'),
        h('li', {}, `Pick ${app.rules.picksPerGroup} breeds in each of the 7 groups. Photos and one-line descriptions help if you don't know dogs.`),
        h('li', {}, 'Choose one of your dogs as your Best in Show call.'),
        h('li', {}, 'Save. You can come back and change picks until noon on Thanksgiving.'),
        h('li', {}, 'Watch the show and this site together. Points pop up as winners are announced.'),
      ),
      h('p', { class: 'muted' }, 'The show was judged the weekend before Thanksgiving. Please don\'t look up the results. It is more fun that way!'),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Points'),
      h('table', { class: 'points' },
        h('tbody', {},
          [['Your breed wins its group', p.place[1]],
            ['Places 2nd / 3rd / 4th in its group', `${p.place[2]} / ${p.place[3]} / ${p.place[4]}`],
            ['Reserve Best in Show (on top of its group win)', p.reserveBestInShow],
            ['Best in Show (on top of its group win)', p.bestInShow],
            ['Your Best in Show call is right', `+${p.bestInShowCallBonus}`],
          ].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, String(b)))))),
      h('p', {}, h('strong', {}, 'Underdog bonus: '), `if ${app.rules.underdogMaxPickers} or fewer players picked a breed, all of that breed's points are doubled for them.`),
      h('p', { class: 'muted' }, 'Ties are broken by who picked more group winners, then by who entered first.'),
    ),
    h('details', { class: 'card credits' },
      h('summary', {}, 'Photo credits'),
      h('p', { class: 'muted' }, 'Most breed photos come from the Dog-Breeds-Dataset by Atharva Taras, licensed CC BY 4.0 (github.com/AtharvaTaras/Dog-Breeds-Dataset). Photos were cropped and resized. A few breeds use the lead image from their Wikipedia article (Wikimedia Commons, free licenses). Breed links below go to Wikipedia.'),
      h('ul', {}, app.breeds.map((b) => h('li', {},
        h('a', { href: `https://en.wikipedia.org/wiki/${encodeURIComponent(b.wiki.replace(/ /g, '_'))}`, target: '_blank', rel: 'noopener noreferrer' }, b.name)))),
    ),
  );
}

init();
