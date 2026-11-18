/**
 * GET /api/img?b=<breedId>
 *
 * Redirects to the lead photo of the breed's Wikipedia article (hosted on
 * Wikimedia Commons under free licenses). The redirect is cached by Vercel's
 * CDN for a week, so Wikipedia is asked at most once per breed per week, and
 * players' browsers load images straight from upload.wikimedia.org.
 *
 * If no suitable photo is found, redirects to a local placeholder.
 */
import { BREED_BY_ID } from '../lib/breeds.js';
import { route, requireMethod, HttpError } from '../lib/http.js';

const PLACEHOLDER = '/placeholder.svg';
const UA = 'FantasyDogDraft/1.0 (small private party game; contact via site owner)';

export default route(async (req, res) => {
  requireMethod(req, 'GET');
  const url = new URL(req.url, 'http://localhost');
  const breed = BREED_BY_ID.get(String(url.searchParams.get('b') || ''));
  if (!breed) throw new HttpError(404, 'Unknown breed');

  const base = breed.wiki;
  const candidates = [...new Set([base, `${base} (dog)`, `${base} (dog breed)`, `${base} dog`])];

  for (const title of candidates) {
    const src = await lookup(title);
    if (src) return redirect(res, src, 7 * 24 * 3600);
  }
  return redirect(res, PLACEHOLDER, 3600);
});

/** Ask Wikipedia's REST API for an article's thumbnail; null if not a dog page. */
async function lookup(title) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal },
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (data.type !== 'standard') return null; // skip disambiguation pages
    const text = `${data.description || ''} ${data.extract || ''}`;
    if (!/\b(dog|dogs|breed|hound|terrier|spaniel|retriever|sheepdog|mastiff|poodle)\b/i.test(text)) return null;
    const src = data.thumbnail?.source;
    // Only ever redirect to Wikimedia's image host (no open redirect).
    if (typeof src !== 'string' || !/^https:\/\/upload\.wikimedia\.org\//.test(src)) return null;
    return src;
  } catch {
    return null; // timeout or network issue: try the next candidate
  } finally {
    clearTimeout(timer);
  }
}

function redirect(res, location, seconds) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', `public, max-age=86400, s-maxage=${seconds}, stale-while-revalidate=86400`);
  res.end();
}
