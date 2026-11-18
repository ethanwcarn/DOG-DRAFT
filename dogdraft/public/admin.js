/**
 * Results Desk: the admin page used during the broadcast.
 *
 * For each group:
 *   - Winner row: pick the breed, press "Announce" (saves + reveals at once).
 *   - 2nd-4th rows are optional. Leave them blank for 0 points, or enter them
 *     ahead of time with "Save hidden" and press "Reveal" when you want the
 *     points to pop on everyone's screen.
 * Best in Show / Reserve: choose from the group winners already entered.
 */
import { h, clear, api } from './dom.js';
import { toast } from './fx.js';

const root = document.getElementById('admin-root');
let catalog = null; // { groups, breeds }
let state = null; // admin state from /api/admin

async function init() {
  try {
    catalog = await api('/api/breeds');
  } catch (e) {
    return showError(`Could not load breeds: ${e.message}`);
  }
  try {
    state = await api('/api/admin');
    render();
  } catch (e) {
    if (e.status === 401) renderLogin();
    else showError(e.message);
  }
}

function showError(msg) {
  clear(root).append(h('p', { class: 'error-box' }, msg));
}

function renderLogin() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Admin password' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin', { method: 'POST', body: { action: 'login', password: pw.value } });
      state = await api('/api/admin');
      render();
    } catch (err) {
      toast(err.message, { kind: 'error' });
      pw.select();
    }
  };
  clear(root).append(h('form', { class: 'card', onsubmit: submit },
    h('h2', {}, 'Admin login'),
    h('div', { class: 'fields' }, h('label', {}, 'Password', pw)),
    h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Log in')),
  ));
  pw.focus();
}

/** Send an admin action, refresh state, and re-render. */
async function act(body, okMsg) {
  try {
    state = await api('/api/admin', { method: 'POST', body });
    render();
    if (okMsg) toast(okMsg, { kind: 'ok', ms: 2500 });
  } catch (e) {
    if (e.status === 401) return renderLogin();
    toast(e.message, { kind: 'error', ms: 5000 });
  }
}

async function logout() {
  try {
    await api('/api/admin', { method: 'POST', body: { action: 'logout' } });
  } catch {
    /* even if the request fails, show the login form */
  }
  state = null;
  renderLogin();
}

const breedName = (id) => catalog.breeds.find((b) => b.id === id)?.name || id;

function render() {
  const scrollY = window.scrollY;
  clear(root);
  const lock = new Date(state.lockAt);

  root.append(h('div', { class: 'card intro' },
    h('h2', {}, 'How to run the show'),
    h('ol', {},
      h('li', {}, 'Keep this page open on your phone and the game open on the TV or laptop.'),
      h('li', {}, 'When a group winner is announced on TV, pick it in that group\'s Winner box and press Announce. Everyone sees it within about 5 seconds.'),
      h('li', {}, '2nd to 4th place are optional. Blank = 0 points. You can pre-enter them with "Save hidden" and press Reveal later.'),
      h('li', {}, 'At the end, announce Reserve Best in Show, then Best in Show.'),
    ),
    h('p', { class: 'muted' }, `Picks ${state.locked ? 'locked' : 'lock'} at ${lock.toLocaleString()}. ${state.players.length} players entered.`),
    !state.locked ? h('p', { class: 'muted' }, 'Heads up: picks are still open. Anything you reveal now is visible to players before they lock in. Use this only to test, then Reset all results.') : null,
  ));

  // Best in Show block first (it is the finale, but it is easiest to find at the top)
  const winners = catalog.groups.map((g) => state.results[`${g.key}:1`]).filter(Boolean);
  root.append(h('div', { class: 'card admin-group', style: { '--accent': '#E0A826' } },
    h('h3', {}, 'Finale'),
    slotRow('RBIS', 'Reserve BIS', winners, false),
    slotRow('BIS', 'Best in Show', winners, false),
    winners.length ? null : h('p', { class: 'muted' }, 'Enter group winners first. They appear here as choices.'),
  ));

  for (const g of catalog.groups) {
    const ids = catalog.breeds.filter((b) => b.group === g.key).map((b) => b.id);
    const hiddenSlots = [1, 2, 3, 4].map((p) => `${g.key}:${p}`).filter((s) => state.results[s] && !state.revealed[s]);
    root.append(h('div', { class: 'card admin-group', style: { '--accent': g.color } },
      h('h3', {}, `${g.name} Group`,
        hiddenSlots.length ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => act({ action: 'reveal', slots: hiddenSlots }, 'Revealed') }, `Reveal ${hiddenSlots.length} hidden`) : null),
      slotRow(`${g.key}:1`, 'Winner', ids, false),
      slotRow(`${g.key}:2`, '2nd (optional)', ids, true),
      slotRow(`${g.key}:3`, '3rd (optional)', ids, true),
      slotRow(`${g.key}:4`, '4th (optional)', ids, true),
    ));
  }

  // Players and maintenance
  const confirmBox = h('input', { placeholder: 'Type RESET', 'aria-label': 'Type RESET to confirm' });
  root.append(
    h('div', { class: 'card' },
      h('h3', {}, `Players (${state.players.length})`),
      h('ul', { class: 'player-list' }, state.players.map((p) => h('li', {},
        h('span', {}, `#${p.rank} ${p.name}: ${p.total} pts`),
        h('button', {
          class: 'btn ghost small', type: 'button',
          onclick: (e) => confirmTwice(e.currentTarget, () => act({ action: 'deletePlayer', id: p.id }, `Removed ${p.name}`)),
        }, 'Remove')))),
    ),
    h('div', { class: 'card' },
      h('h3', {}, 'Reset all results'),
      h('p', { class: 'muted' }, 'Clears every result (for after testing). Player picks are kept.'),
      h('div', { class: 'fields' }, confirmBox),
      h('p', {}, h('button', { class: 'btn danger', type: 'button', onclick: () => act({ action: 'resetResults', confirm: confirmBox.value.trim() }, 'All results cleared') }, 'Reset results')),
      h('p', {}, h('button', { class: 'btn ghost', type: 'button', onclick: logout }, 'Log out')),
    ),
  );
  window.scrollTo({ top: scrollY });
}

/** A button that asks "Sure?" on the first tap and acts on the second. */
function confirmTwice(btn, fn) {
  if (btn.dataset.armed) return fn();
  btn.dataset.armed = '1';
  const original = btn.textContent;
  btn.textContent = 'Tap again to confirm';
  setTimeout(() => {
    delete btn.dataset.armed;
    btn.textContent = original;
  }, 4000);
}

/**
 * One result slot: dropdown + actions.
 * @param {string} slot
 * @param {string} label
 * @param {string[]} options breed ids allowed in this slot
 * @param {boolean} optional placements 2-4 can be saved hidden
 */
function slotRow(slot, label, options, optional) {
  const current = state.results[slot] || '';
  const live = state.revealed[slot];
  const select = h('select', { 'aria-label': `${label} breed` },
    h('option', { value: '' }, current ? '(clear)' : 'Choose a breed...'),
    options.map((id) => h('option', { value: id, selected: id === current }, breedName(id))));

  const save = (reveal) => {
    if (!select.value) return toast('Choose a breed first.', { kind: 'warn' });
    act({ action: 'set', slot, breedId: select.value, reveal }, reveal ? `${breedName(select.value)} announced!` : 'Saved (hidden)');
  };

  return h('div', { class: 'slot-row' },
    h('div', {}, h('strong', {}, label), h('br'),
      current ? h('span', { class: `status ${live ? 'live' : 'hidden'}` }, live ? 'Live' : 'Hidden') : h('span', { class: 'status' }, 'Empty')),
    select,
    h('div', { class: 'slot-actions' },
      h('button', { class: 'btn primary small', type: 'button', onclick: () => save(true) }, current && live ? 'Update' : 'Announce'),
      optional ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => save(false) }, 'Save hidden') : null,
      current && !live ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => act({ action: 'reveal', slots: [slot] }, 'Revealed') }, 'Reveal') : null,
      current ? h('button', {
        class: 'btn ghost small', type: 'button',
        onclick: (e) => confirmTwice(e.currentTarget, () => act({ action: 'clear', slot }, 'Cleared')),
      }, 'Clear') : null,
    ),
  );
}

init();
