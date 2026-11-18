/**
 * Celebration effects: confetti, award overlays, toasts, floating "+N"
 * points, and FLIP animation for leaderboard reordering.
 *
 * All effects respect "reduce motion": confetti and movement are skipped,
 * and the award cards still appear (without animation) so no info is lost.
 */
import { h, clear, reducedMotion } from './dom.js';

// ---------------------------------------------------------------------------
// Confetti (small canvas particle system; no external library)
// ---------------------------------------------------------------------------
const canvas = document.getElementById('confetti');
const ctx = canvas.getContext('2d');
let particles = [];
let rafId = null;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/**
 * @param {string[]} colors
 * @param {number} count number of pieces
 * @param {{x?:number,y?:number,spread?:number}} origin fraction of screen
 */
export function confetti(colors, count = 120, origin = {}) {
  if (reducedMotion()) return;
  const ox = (origin.x ?? 0.5) * window.innerWidth;
  const oy = (origin.y ?? 0.35) * window.innerHeight;
  const spread = origin.spread ?? Math.PI * 2;
  for (let i = 0; i < count; i += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
    const speed = 6 + Math.random() * 9;
    particles.push({
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length],
      life: 0,
      ttl: 140 + Math.random() * 60,
    });
  }
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  particles = particles.filter((p) => p.life < p.ttl && p.y < window.innerHeight + 40);
  for (const p of particles) {
    p.life += 1;
    p.vy += 0.25; // gravity
    p.vx *= 0.99; // air drag
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.life / p.ttl);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life / 8)));
    ctx.restore();
  }
  rafId = particles.length ? requestAnimationFrame(tick) : null;
  if (!rafId) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// Award overlay (group winner, Reserve BIS, Best in Show)
// ---------------------------------------------------------------------------
const overlayRoot = document.getElementById('overlay-root');

/**
 * Show an award card. Resolves when it is dismissed (tap/Esc/timeout), so
 * a queue of awards plays one after another.
 *
 * @param {{kind:'group'|'reserve'|'bis', title:string, breed:object,
 *          imgSrc:string, color:string, lines:string[], youLine?:string}} o
 */
export function showAward(o) {
  return new Promise((resolve) => {
    const ttl = o.kind === 'bis' ? 15000 : o.kind === 'reserve' ? 8000 : 6500;
    const close = () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer);
      overlay.classList.add('leaving');
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, reducedMotion() ? 0 : 300);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') close();
    };

    const card = h(
      'div',
      { class: `award-card award-${o.kind}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title, style: { '--accent': o.color } },
      o.kind === 'bis' ? h('img', { class: 'trophy', src: '/trophy.svg', alt: '' }) : h('div', { class: 'ribbon' }),
      h('p', { class: 'award-kicker' }, o.title),
      h('img', { class: 'award-photo', src: o.imgSrc, alt: o.breed.name, onerror: onImgError }),
      h('h2', { class: 'award-name' }, o.breed.name),
      h('p', { class: 'award-blurb' }, o.breed.blurb),
      ...o.lines.map((l) => h('p', { class: 'award-line' }, l)),
      o.youLine ? h('p', { class: 'award-you' }, o.youLine) : null,
      h('button', { class: 'btn ghost award-close', type: 'button', onclick: () => close() }, 'Continue'),
    );
    const overlay = h('div', { class: `overlay overlay-${o.kind}`, onclick: (e) => e.target === overlay && close() }, card);
    overlayRoot.appendChild(overlay);
    card.querySelector('.award-close').focus({ preventScroll: true });
    document.addEventListener('keydown', onKey);
    const timer = setTimeout(close, ttl);

    if (o.kind === 'bis') {
      const gold = ['#F5C542', '#FFE08A', '#C9971C', '#FFFFFF', o.color];
      confetti(gold, 220, { x: 0.5, y: 0.3 });
      setTimeout(() => confetti(gold, 140, { x: 0.1, y: 0.6, spread: Math.PI / 2 }), 600);
      setTimeout(() => confetti(gold, 140, { x: 0.9, y: 0.6, spread: Math.PI / 2 }), 1100);
    } else if (o.kind === 'reserve') {
      confetti(['#C0C7D1', '#E8ECF1', '#8A94A3', '#FFFFFF'], 150);
    } else {
      confetti([o.color, '#F5C542', '#FFFFFF'], 130);
    }
  });
}

// ---------------------------------------------------------------------------
// Toasts (2nd-4th placements, save confirmations, errors)
// ---------------------------------------------------------------------------
const toastRoot = document.getElementById('toasts');

export function toast(text, { kind = 'info', ms = 3500, color } = {}) {
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', style: color ? { '--accent': color } : null }, text);
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
  return new Promise((r) => setTimeout(r, Math.min(ms, 1600)));
}

// ---------------------------------------------------------------------------
// Floating "+N" from an element
// ---------------------------------------------------------------------------
export function floatPoints(anchorEl, text) {
  // offsetParent is null when the element (or its tab) is hidden.
  if (!anchorEl || !anchorEl.offsetParent || reducedMotion()) return;
  const r = anchorEl.getBoundingClientRect();
  const el = h('div', { class: 'float-points', style: { left: `${r.left + r.width / 2}px`, top: `${r.top}px` } }, text);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

// ---------------------------------------------------------------------------
// FLIP: animate list items from their old positions to new ones
// ---------------------------------------------------------------------------
/** Call before re-rendering: returns a function to call after re-rendering. */
export function flip(container, keyAttr = 'data-key') {
  const first = new Map();
  container.querySelectorAll(`[${keyAttr}]`).forEach((el) => first.set(el.getAttribute(keyAttr), el.getBoundingClientRect().top));
  return () => {
    if (reducedMotion()) return;
    container.querySelectorAll(`[${keyAttr}]`).forEach((el) => {
      const before = first.get(el.getAttribute(keyAttr));
      if (before === undefined) return;
      const delta = before - el.getBoundingClientRect().top;
      if (Math.abs(delta) < 2) return;
      el.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
        duration: 700,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      });
      el.classList.add(delta > 0 ? 'moved-up' : 'moved-down');
      setTimeout(() => el.classList.remove('moved-up', 'moved-down'), 4000);
    });
  };
}

/** Swap a broken photo for the placeholder (only once, to avoid loops). */
export function onImgError(e) {
  const img = e.currentTarget;
  if (img.dataset.fallback) return;
  img.dataset.fallback = '1';
  img.src = '/placeholder.svg';
}

export function clearOverlays() {
  clear(overlayRoot);
}
