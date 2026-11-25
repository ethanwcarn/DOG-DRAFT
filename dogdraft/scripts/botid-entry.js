// Entry point bundled into public/botid.js by scripts/build-botid.mjs.
import { initBotId } from 'botid/client/core';

/* global __BOTID_PROTECTED__ */
const PROTECTED = __BOTID_PROTECTED__;
const CHALLENGE_TIMEOUT_MS = 8000;

// BotID wraps window.fetch to attach its challenge header. If its challenge
// script is blocked (extension, flaky network) that wrapper throws, and if the
// script never answers it waits forever. Either way the player would be stuck
// on a dead button. So keep the plain fetch, and for protected requests fall
// back to it when BotID fails or stalls. The server then makes the call: worst
// case is a clear "please refresh" message instead of a hang.
const plainFetch = window.fetch.bind(window);
initBotId({ protect: PROTECTED });
const botidFetch = window.fetch;

function isProtected(input, init) {
  try {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin) return false;
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return PROTECTED.some((r) => r.path === url.pathname && r.method === method);
  } catch {
    return false;
  }
}

window.fetch = (input, init) => {
  if (!isProtected(input, init)) return botidFetch(input, init);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('BotID challenge timed out')), CHALLENGE_TIMEOUT_MS);
  });
  return Promise.race([botidFetch(input, init), timeout])
    .catch((err) => {
      console.warn('BotID unavailable, sending without it:', err && err.message);
      return plainFetch(input, init);
    })
    .finally(() => clearTimeout(timer));
};
