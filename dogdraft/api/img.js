/**
 * GET /api/img?b=<breedId>
 *
 * Redirects to the lead photo of the breed's Wikipedia article (hosted on
 * Wikimedia Commons under free licenses). The redirect is cached by Vercel's
 * CDN for a week, so Wikipedia is asked at most about once per breed per week,
 * and players' browsers load the images straight from upload.wikimedia.org.
 *
 * Uses the MediaWiki Action API (stable, long-lived) rather than the older
 * REST summary endpoint. If no suitable photo is found, redirects to a local
 * placeholder (cached briefly so a temporary Wikipedia hiccup heals itself).
 *
 * Diagnostics: /api/img?b=<breedId>&debug=1 returns JSON describing each
 * lookup attempt instead of redirecting. It exposes nothing sensitive.
 */
import { BREED_BY_ID } from '../lib/breeds.js';
import { route, requireMethod, sendJson, HttpError } from '../lib/http.js';

const PLACEHOLDER = '/placeholder.svg';
// Wikimedia's User-Agent policy asks for a descriptive agent with a contact
// URL; generic agents from cloud hosts can be rejected with 403.
const UA = 'FantasyDogDraft/1.1 (https://dogdraft.ethan-carn.work; private party game) node-fetch';
const DOGGY = /\b(dog|dogs|breed|hound|terrier|spaniel|retriever|sheepdog|mastiff|poodle|setter|pointer|collie|corgi)\b/i;

export default route(async (req, res) => {
  requireMethod(req, 'GET');
  const url = new URL(req.url, 'http://localhost');
  const breed = BREED_BY_ID.get(String(url.searchParams.get('b') || ''));
  if (!breed) throw new HttpError(404, 'Unknown breed');
  const debug = url.searchParams.get('debug') === '1';

  const base = breed.wiki;
  const candidates = [...new Set([base, `${base} (dog)`, `${base} (dog breed)`, `${base} dog`])];
  const attempts = [];

  for (const title of candidates) {
    const result = await lookup(title);
    attempts.push({ title, ...result });
    if (result.src) {
      if (debug) return sendJson(res, 200, { breed: breed.name, chosen: result.src, attempts });
      return redirect(res, result.src, 7 * 24 * 3600);
    }
  }
  if (debug) return sendJson(res, 200, { breed: breed.name, chosen: null, attempts });
  console.warn('img: no photo for', breed.id, JSON.stringify(attempts));
  return redirect(res, PLACEHOLDER, 600);
});

/**
 * Look up one article title. Returns { src } on success, or { reason } so
 * failures can be diagnosed.
 */
async function lookup(title) {
  const api = new URL('https://en.wikipedia.org/w/api.php');
  api.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    prop: 'pageimages|description|pageprops',
    piprop: 'thumbnail',
    pithumbsize: '480',
    ppprop: 'disambiguation',
    titles: title,
  }).toString();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(api, {
      headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) return { reason: `http ${r.status}` };
    const data = await r.json();
    const page = data?.query?.pages?.[0];
    if (!page || page.missing) return { reason: 'no such article' };
    if (page.pageprops && 'disambiguation' in page.pageprops) return { reason: 'disambiguation page' };
    const text = `${page.title || ''} ${page.description || ''}`;
    if (!DOGGY.test(text)) return { reason: `not a dog article (${page.description || 'no description'})` };
    const src = page.thumbnail?.source;
    // Only ever redirect to Wikimedia's image host (no open redirect).
    if (typeof src !== 'string' || !/^https:\/\/upload\.wikimedia\.org\//.test(src)) return { reason: 'no lead image' };
    return { src };
  } catch (e) {
    return { reason: e.name === 'AbortError' ? 'timeout' : `fetch error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function redirect(res, location, seconds) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', `public, max-age=${Math.min(seconds, 86400)}, s-maxage=${seconds}`);
  res.end();
}
