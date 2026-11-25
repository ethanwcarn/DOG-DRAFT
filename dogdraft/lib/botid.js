/**
 * Vercel BotID check for the sign-in and picks endpoints.
 *
 * The browser half lives in public/botid.js (built from botid/client/core by
 * scripts/build-botid.mjs). It runs an invisible challenge and attaches an
 * `x-is-human` header to POSTs to the protected paths. Here we ask Vercel's
 * classifier whether that request came from a real browser.
 *
 * Failure policy, chosen so a BotID outage can't lock the family out on
 * Thanksgiving morning:
 *   - Vercel says "bot"            -> 403, with a "refresh the page" message.
 *   - The check itself errors      -> allow and log (rate limits, honeypot and
 *                                     the one-entry-per-device rule still apply).
 *   - BOTID_DISABLED=1 env var     -> skip the check entirely (emergency switch).
 *   - Not running on Vercel        -> skip (local dev server and tests).
 */

import { checkBotId } from 'botid/server';
import { HttpError, clientIp } from './http.js';

// Paths the browser script protects. Keep in sync with scripts/build-botid.mjs.
export const BOTID_PROTECTED = [
  { path: '/api/auth', method: 'POST' },
  { path: '/api/picks', method: 'POST' },
];

export const BOT_BLOCKED_MESSAGE =
  "We couldn't confirm you're using a normal browser. Please refresh the page and try again.";

let testCheck = null;

/** Tests only: replace the Vercel call. fn(req) returns true for "bot". Pass null to reset. */
export function setTestBotCheck(fn) {
  testCheck = fn;
}

export async function requireHuman(req, label) {
  if (testCheck) {
    if (await testCheck(req)) throw new HttpError(403, BOT_BLOCKED_MESSAGE);
    return;
  }
  if (process.env.BOTID_DISABLED === '1') return;
  if (process.env.VERCEL !== '1') return;

  let verdict;
  try {
    verdict = await checkBotId({ advancedOptions: { headers: req.headers } });
  } catch (err) {
    console.error(`botid (${label}): check failed, allowing request:`, err && err.message);
    return;
  }
  if (verdict.isBot) {
    console.warn(`botid (${label}): blocked request from`, clientIp(req));
    throw new HttpError(403, BOT_BLOCKED_MESSAGE);
  }
}
