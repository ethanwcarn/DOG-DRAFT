/**
 * Tiny DOM helpers. Everything user-provided is inserted with textContent,
 * never innerHTML, so names like "<script>" are displayed as plain text.
 */

/**
 * h('div', { class: 'x', onclick: fn, dataset: { id: 1 } }, 'text', childEl)
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      // setProperty handles CSS custom properties ("--accent"), Object.assign does not.
      for (const [prop, val] of Object.entries(v)) {
        if (val === null || val === undefined) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, String(val));
        else el.style[prop] = val;
      }
    }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** localStorage that never throws (private mode, blocked storage, etc). */
export const store = {
  get(key, fallback = null) {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: feature silently degrades */
    }
  },
  remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** fetch JSON with a timeout and readable errors. */
export async function api(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON response */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server took too long to answer. Check your connection and try again.');
    if (e instanceof TypeError) throw new Error('Could not reach the server. Check your connection and try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const reducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
