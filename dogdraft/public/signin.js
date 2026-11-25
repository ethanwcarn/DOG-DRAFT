/**
 * Sign-in screen: "Sign in with Google" or name + 4-digit PIN.
 *
 * The server keeps the player signed in for 60 days with an HttpOnly cookie,
 * so this screen only shows for new visitors or after signing out.
 *
 * Google flow (when GOOGLE_CLIENT_ID is configured):
 *   credential -> /api/auth { action: "google" }
 *     signedIn   -> done
 *     needsName  -> ask for first/last name (Google didn't give both)
 *     needsLink  -> an entry with that name already exists with a PIN:
 *                   ask for the PIN once to connect it to this Google account
 */
import { h, clear, api } from './dom.js';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiPromise = null;
let gsiInitializedFor = null;
let onCredential = null; // current screen's handler (screen can be re-rendered)

/** Load Google's sign-in script once. */
function loadGsi() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GSI_SRC;
      s.async = true;
      s.onload = () => (window.google?.accounts?.id ? resolve() : reject(new Error('Google script loaded without API')));
      s.onerror = () => reject(new Error('Could not load Google sign-in'));
      document.head.appendChild(s);
    }).catch((e) => {
      gsiPromise = null; // allow a retry next time the screen shows
      throw e;
    });
  }
  return gsiPromise;
}

/**
 * @param {HTMLElement} root
 * @param {{ googleClientId: string|null, locked: boolean,
 *           onSignedIn: (player: object, created: boolean) => void,
 *           onWatch: () => void }} opts
 */
export function renderSignIn(root, { googleClientId, locked, onSignedIn, onWatch }) {
  clear(root);
  const error = h('p', { class: 'error-inline', role: 'alert', hidden: true });
  const showError = (msg) => {
    error.textContent = msg;
    error.hidden = !msg;
  };
  const extra = h('div', { class: 'signin-extra' }); // follow-up steps for Google (name / link)

  // ---------- Name + PIN ----------
  const first = h('input', { id: 'si-first', autocomplete: 'given-name', maxlength: 30, required: true });
  const last = h('input', { id: 'si-last', autocomplete: 'family-name', maxlength: 30, required: true });
  const pin = h('input', { id: 'si-pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]{4}', maxlength: 4, autocomplete: 'off', required: true });
  const trap = h('input', { id: 'si-hp', name: 'dd_hp_x7', type: 'text', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const submit = h('button', { class: 'btn primary wide', type: 'submit' }, locked ? 'Sign in' : 'Continue');

  const busy = (on, btn = submit, label = null) => {
    btn.disabled = on;
    if (label) btn.textContent = label;
  };

  const pinForm = h('form', {
    class: 'signin-form',
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      showError('');
      const f = first.value.trim();
      const l = last.value.trim();
      const p = pin.value.trim();
      if (!f || !l) return showError('Please enter your first and last name.');
      if (!/^\d{4}$/.test(p)) return showError('Your PIN must be exactly 4 digits.');
      const label = submit.textContent;
      busy(true, submit, 'Signing in...');
      try {
        const r = await api('/api/auth', { method: 'POST', body: { action: 'pin', firstName: f, lastName: l, pin: p, hp: trap.value } });
        onSignedIn(r.player, r.created);
      } catch (err) {
        showError(err.message);
      } finally {
        busy(false, submit, label);
      }
    },
  },
  h('div', { class: 'fields' },
    h('label', {}, 'First name', first),
    h('label', {}, 'Last name', last),
    h('label', {}, '4-digit PIN', pin)),
  h('div', { class: 'hp', 'aria-hidden': 'true' }, trap),
  h('p', { class: 'muted small-note' }, locked
    ? 'Use the same name and PIN you entered with.'
    : 'New here? Make up any 4-digit PIN. Already entered? Use the same name and PIN as before.'),
  submit);

  // ---------- Google ----------
  let googleBlock = null;
  if (googleClientId) {
    const btnHost = h('div', { class: 'gsi-host', id: 'gsi-btn' }, h('span', { class: 'muted' }, 'Loading Google sign-in...'));
    googleBlock = h('div', { class: 'google-block' },
      btnHost,
      h('p', { class: 'muted small-note' }, 'Your Google name becomes your player name.'));

    let credential = null;
    const postGoogle = async (more = {}) => {
      showError('');
      try {
        const r = await api('/api/auth', { method: 'POST', body: { action: 'google', credential, ...more } });
        if (r.signedIn) return onSignedIn(r.player, r.created);
        if (r.needsName) return askName(r.suggested || {});
        if (r.needsLink) return askLink(r.first, r.last);
        showError('Something went wrong. Please try again.');
      } catch (err) {
        showError(err.message);
      }
    };

    // Google didn't give us a first AND last name
    const askName = (suggested) => {
      const f = h('input', { autocomplete: 'given-name', maxlength: 30, value: suggested.first || '' });
      const l = h('input', { autocomplete: 'family-name', maxlength: 30, value: suggested.last || '' });
      const go = h('button', { class: 'btn primary', type: 'submit' }, 'Continue');
      clear(extra).append(h('form', {
        class: 'card-inset',
        onsubmit: async (e) => {
          e.preventDefault();
          busy(true, go);
          await postGoogle({ firstName: f.value.trim(), lastName: l.value.trim() });
          busy(false, go);
        },
      }, h('p', {}, h('strong', {}, 'What name should we show on the leaderboard?')),
      h('div', { class: 'fields' }, h('label', {}, 'First name', f), h('label', {}, 'Last name', l)), go));
      f.focus();
    };

    // An entry with this name already exists (made with a PIN): prove it's yours once
    const askLink = (fName, lName) => {
      const p = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]{4}', maxlength: 4, autocomplete: 'off', 'aria-label': '4-digit PIN' });
      const go = h('button', { class: 'btn primary', type: 'submit' }, 'Connect Google');
      clear(extra).append(h('form', {
        class: 'card-inset',
        onsubmit: async (e) => {
          e.preventDefault();
          showError('');
          if (!/^\d{4}$/.test(p.value.trim())) return showError('Enter the 4-digit PIN you chose when you first entered.');
          busy(true, go, 'Connecting...');
          try {
            const r = await api('/api/auth', { method: 'POST', body: { action: 'link', credential, pin: p.value.trim(), firstName: fName, lastName: lName } });
            onSignedIn(r.player, false);
          } catch (err) {
            showError(err.message);
          } finally {
            busy(false, go, 'Connect Google');
          }
        },
      }, h('p', {}, h('strong', {}, `Welcome back, ${fName}!`), ` There's already an entry for ${fName} ${lName}. Enter its 4-digit PIN once to connect your Google account. After that, Google signs you straight in.`),
      h('div', { class: 'fields' }, h('label', {}, 'Your PIN', p)), go));
      p.focus();
    };

    onCredential = (resp) => {
      credential = resp?.credential || null;
      if (!credential) return showError('Google sign-in was cancelled. Please try again.');
      postGoogle();
    };

    loadGsi().then(() => {
      if (gsiInitializedFor !== googleClientId) {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (resp) => onCredential && onCredential(resp),
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
        });
        gsiInitializedFor = googleClientId;
      }
      clear(btnHost);
      const width = Math.max(220, Math.min(340, btnHost.clientWidth || 320));
      window.google.accounts.id.renderButton(btnHost, {
        type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'left', width,
      });
    }).catch(() => {
      clear(btnHost).append(h('p', { class: 'muted' }, 'Google sign-in couldn’t load (an ad blocker can cause this). Use your name and PIN below.'));
    });
  }

  root.append(
    h('div', { class: 'card intro signin-intro' },
      h('h2', {}, locked ? 'Sign in to see your team' : 'Welcome to the Fantasy Dog Draft!'),
      h('p', {}, locked
        ? 'Picks are locked and the show is on. Sign in to follow your dogs, or just watch the leaderboard.'
        : 'Sign in to make your picks. You’ll stay signed in on this device, so you can come back anytime to change them before the show.')),
    h('div', { class: 'card signin' },
      error,
      googleBlock,
      extra,
      googleBlock ? h('div', { class: 'divider' }, h('span', {}, 'or use your name and a PIN')) : null,
      pinForm,
      h('p', { class: 'watch-link' }, h('button', { class: 'linklike', type: 'button', onclick: onWatch }, 'Just watching? See the leaderboard'))),
  );
}
