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
  page: {}, // group key -> current page index in the breed carousel
};

const PAGE_SIZE = 6; // breeds shown per group at once (one row on desktop)
const NAME_RE = /^[\p{L}][\p{L}\p{M} .'\u2019-]{0,29}$/u; // same rule the server enforces

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
  const pin = h('input', { id: 'in-pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]{4}', maxlength: 4, autocomplete: 'off', oninput: updateGate });
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
    oninput: (e) => {
      app.filter = e.target.value;
      app.page = {}; // new search: start every group at its first page
      applyFilter();
    },
  });
  root.append(h('div', { class: 'card step sticky-search' },
    h('div', { class: 'step-head' },
      h('h3', {}, h('span', { class: 'step-num' }, '2'), `Choose your ${total} dogs`),
      h('button', { class: 'btn secondary small', id: 'random-btn', type: 'button', onclick: randomPicks }, 'Pick randomly for me'),
    ),
    h('p', { class: 'gate-hint', id: 'gate-hint', hidden: true }, 'Fill in your name and PIN in step 1 to start picking.'),
    search,
  ));

  for (const g of app.groups) {
    const breeds = app.breeds.filter((b) => b.group === g.key);
    const grid = h('div', { class: 'breed-grid' }, breeds.map((b) => breedCard(b)));
    addSwipe(grid, g.key);
    root.append(
      h('section', { class: 'group', id: `group-${g.key}`, style: { '--accent': g.color } },
        h('div', { class: 'group-head' },
          h('h3', {}, `${g.name} Group`),
          h('div', { class: 'mine', id: `mine-${g.key}` }),
          h('span', { class: 'counter', id: `count-${g.key}` }, ''),
        ),
        h('div', { class: 'carousel' },
          h('button', { class: 'pager prev', type: 'button', 'aria-label': `Previous ${g.name} breeds`, onclick: () => turnPage(g.key, -1) }),
          grid,
          h('button', { class: 'pager next', type: 'button', 'aria-label': `More ${g.name} breeds`, onclick: () => turnPage(g.key, 1) }),
        ),
        h('p', { class: 'page-info muted', id: `pageinfo-${g.key}` }),
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
  updateGate();
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
  updateGate();
}

// ---------------------------------------------------------------------------
// Step 1 gate: no picking until name and PIN are filled in
// ---------------------------------------------------------------------------

/** What's still missing from step 1, as [label, inputId] pairs. */
function missingIdentity() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const missing = [];
  if (!NAME_RE.test(val('in-first'))) missing.push(['your first name', 'in-first']);
  if (!NAME_RE.test(val('in-last'))) missing.push(['your last name', 'in-last']);
  if (!/^\d{4}$/.test(val('in-pin'))) missing.push(['a 4-digit PIN', 'in-pin']);
  return missing;
}

/** Dim the breed grid and show a hint while step 1 is incomplete. */
function updateGate() {
  const blocked = missingIdentity().length > 0;
  document.getElementById('tab-picks')?.classList.toggle('needs-id', blocked);
  const hint = document.getElementById('gate-hint');
  if (hint) hint.hidden = !blocked;
}

/** Returns true if step 1 is complete; otherwise explains what's missing in a pop-up. */
function requireIdentity() {
  const missing = missingIdentity();
  if (!missing.length) return true;
  const list = missing.map(([label]) => label);
  const text = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  showNotice(
    'First, tell us who you are',
    `Before you pick dogs, please enter ${text} in step 1. Your PIN lets you come back and change your picks later.`,
    () => {
      const input = document.getElementById(missing[0][1]);
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus({ preventScroll: true });
    },
  );
  return false;
}

/** Small modal pop-up with one button. */
function showNotice(title, text, onClose) {
  const root = document.getElementById('overlay-root');
  if (root.querySelector('.notice-card')) return; // already showing
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      close();
    }
  };
  const btn = h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Got it');
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && close() },
    h('div', { class: 'notice-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'notice-title', 'aria-describedby': 'notice-text' },
      h('h2', { id: 'notice-title' }, title),
      h('p', { id: 'notice-text' }, text),
      btn));
  root.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  btn.focus();
}

// ---------------------------------------------------------------------------
// Random picks
// ---------------------------------------------------------------------------

/**
 * Fill every empty slot with random breeds (keeping picks already made) and
 * choose a random Best in Show call if there isn't one. When the entry is
 * already complete, a second tap re-rolls everything.
 */
function randomPicks(e) {
  if (!requireIdentity()) return;
  const btn = e.currentTarget;
  const ppg = app.rules.picksPerGroup;
  const complete = app.groups.every((g) => app.draft.picks[g.key].length === ppg) && app.draft.bisPick;
  if (complete) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to re-roll all';
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = 'Pick randomly for me';
      }, 4000);
      return;
    }
    delete btn.dataset.armed;
    btn.textContent = 'Pick randomly for me';
    for (const g of app.groups) app.draft.picks[g.key] = [];
    app.draft.bisPick = null;
  }
  let added = 0;
  for (const g of app.groups) {
    const list = app.draft.picks[g.key];
    const pool = shuffle(app.breeds.filter((b) => b.group === g.key && !list.includes(b.id)).map((b) => b.id));
    while (list.length < ppg && pool.length) {
      list.push(pool.pop());
      added += 1;
    }
  }
  if (!app.draft.bisPick) {
    const ids = allPicks();
    app.draft.bisPick = ids[Math.floor(Math.random() * ids.length)];
  }
  store.set('dd_draft', app.draft);
  refreshSelection();
  confetti(['#F5C542', '#2E7D32', '#1565C0', '#C62828'], 70, { y: 0.3, spread: Math.PI / 2 });
  toast(added ? `Picked ${added} dogs for you. Swap any you like, then tap Save.` : 'Your team is already full.', { kind: 'ok', ms: 4500 });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Carousel paging (6 breeds per group at a time)
// ---------------------------------------------------------------------------

function turnPage(groupKey, delta) {
  app.page[groupKey] = (app.page[groupKey] || 0) + delta;
  applyFilter({ animate: groupKey, dir: delta });
}

/** Swipe left/right on touch screens to change pages. */
function addSwipe(el, groupKey) {
  let x0 = null;
  let y0 = null;
  el.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) turnPage(groupKey, dx < 0 ? 1 : -1);
  }, { passive: true });
}

function toggle(b) {
  const list = app.draft.picks[b.group];
  const i = list.indexOf(b.id);
  if (i < 0 && !requireIdentity()) return; // removing is always allowed; adding needs step 1
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
    // Show this group's picks in its header, since they may be on another page
    const mine = document.getElementById(`mine-${g.key}`);
    if (mine) {
      clear(mine);
      for (const id of app.draft.picks[g.key]) {
        const b = app.byId.get(id);
        mine.append(h('button', {
          type: 'button', class: 'mini', title: `Remove ${b.name}`, 'aria-label': `Remove ${b.name}`,
          onclick: () => toggle(b),
        }, h('img', { ...photoAttrs(id), alt: '', onerror: onImgError }), h('span', {}, b.name), h('span', { class: 'x', 'aria-hidden': 'true' }, '\u00d7')));
      }
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

/**
 * Apply the search filter and the per-group page. Only PAGE_SIZE matching
 * breeds are visible per group; picks live in app.draft, so they are kept no
 * matter which page is showing.
 */
function applyFilter({ animate = null, dir = 1 } = {}) {
  const q = app.filter.trim().toLowerCase();
  document.querySelectorAll('#tab-picks .group').forEach((sec) => {
    const key = sec.id.replace('group-', '');
    const cards = [...sec.querySelectorAll('.breed')];
    const matches = cards.filter((el) => !q || el.dataset.search.includes(q));
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const page = Math.min(Math.max(app.page[key] || 0, 0), pages - 1);
    app.page[key] = page;
    const visible = new Set(matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
    for (const el of cards) el.hidden = !visible.has(el);

    sec.querySelector('.pager.prev').disabled = page === 0;
    sec.querySelector('.pager.next').disabled = page >= pages - 1;
    sec.querySelector('.carousel').classList.toggle('single', pages === 1);
    const info = sec.querySelector('.page-info');
    info.textContent = matches.length
      ? `Showing ${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, matches.length)} of ${matches.length} ${q ? 'matches' : 'breeds'}`
      : '';
    sec.querySelector('.no-match').hidden = matches.length > 0;

    if (animate === key) {
      const grid = sec.querySelector('.breed-grid');
      grid.classList.remove('slide-left', 'slide-right');
      void grid.offsetWidth; // restart the CSS animation
      grid.classList.add(dir > 0 ? 'slide-left' : 'slide-right');
    }
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
