/**
 * GET /api/img?b=<breedId>
 *
 * Redirects to a photo of the breed hosted on Wikimedia Commons (free
 * licenses). The redirect is cached by Vercel's CDN for a week, so Wikimedia
 * is asked at most about once per breed per week, and players' browsers load
 * images straight from upload.wikimedia.org.
 *
 * Lookup order for each candidate article title:
 *   1. The article's lead image (PageImages thumbnail)          fastest
 *   2. The breed's official image on Wikidata (property P18)    most reliable
 *   3. The first photo (jpg/png) used in the article            last resort
 * Steps 2 and 3 resolve a file name to a thumbnail URL through the Commons
 * API, so the final URL is always on upload.wikimedia.org.
 *
 * If nothing is found, redirects to a local placeholder (cached for only 10
 * minutes so a temporary Wikimedia hiccup heals itself).
 *
 * Diagnostics: /api/img?b=<breedId>&debug=1 returns JSON describing each
 * lookup attempt instead of redirecting. It exposes nothing sensitive.
 */
import { BREED_BY_ID } from '../lib/breeds.js';
import { route, requireMethod, sendJson, HttpError } from '../lib/http.js';

const PLACEHOLDER = '/placeholder.svg';
const THUMB_WIDTH = 480;
// Wikimedia's User-Agent policy asks for a descriptive agent with a contact
// URL; generic agents from cloud hosts can be rejected with 403.
const UA = 'FantasyDogDraft/1.2 (https://dogdraft.ethan-carn.work; private party game) node-fetch';
const DOGGY = /\b(dog|dogs|breed|hound|terrier|spaniel|retriever|sheepdog|mastiff|poodle|setter|pointer|collie|corgi)\b/i;
const PHOTO_FILE = /\.(jpe?g|png|webp)$/i;
const NOT_A_PHOTO = /(logo|icon|map|flag|symbol|commons-|wiki|edit|question|ambox|stub|signature|coat[_ ]of[_ ]arms)/i;

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
    let result;
    try {
      result = await findPhoto(title);
    } catch (e) {
      result = { reason: e.name === 'AbortError' ? 'timeout' : `error: ${e.message}` };
    }
    attempts.push({ title, ...result });
    if (result.src) {
      if (debug) return sendJson(res, 200, { breed: breed.name, chosen: result.src, attempts });
      return redirect(res, result.src, 7 * 24 * 3600);
    }
    if (result.stop) break; // the article was right but had no usable photo anywhere
  }
  if (debug) return sendJson(res, 200, { breed: breed.name, chosen: null, attempts });
  console.warn('img: no photo for', breed.id, JSON.stringify(attempts));
  return redirect(res, PLACEHOLDER, 600);
});

/**
 * Try every source for one article title.
 * @returns {Promise<{src?:string, via?:string, reason?:string, stop?:boolean}>}
 */
export async function findPhoto(title) {
  const data = await getJson('en.wikipedia.org', {
    action: 'query',
    redirects: '1',
    prop: 'pageimages|description|pageprops',
    piprop: 'thumbnail|name',
    pithumbsize: String(THUMB_WIDTH),
    ppprop: 'disambiguation|wikibase_item|page_image_free',
    titles: title,
  });
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return { reason: 'no such article' };
  if (page.pageprops && 'disambiguation' in page.pageprops) return { reason: 'disambiguation page' };
  const text = `${page.title || ''} ${page.description || ''}`;
  if (!DOGGY.test(text)) return { reason: `not a dog article (${page.description || 'no description'})` };

  const notes = [];

  // 1. Lead image thumbnail
  if (isWikimediaUrl(page.thumbnail?.source)) return { src: page.thumbnail.source, via: 'lead image' };
  notes.push('no lead thumbnail');

  // 1b. PageImages knows the file name but gave no thumbnail
  const leadName = page.pageimage || page.pageprops?.page_image_free;
  if (leadName) {
    const src = await thumbForFile(leadName);
    if (src) return { src, via: 'lead image file' };
    notes.push(`lead file unresolved (${leadName})`);
  }

  // 2. Wikidata P18 ("image") for the breed
  const qid = page.pageprops?.wikibase_item;
  if (qid && /^Q\d+$/.test(qid)) {
    const wd = await getJson('www.wikidata.org', { action: 'wbgetclaims', entity: qid, property: 'P18' });
    const fileName = wd?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (typeof fileName === 'string') {
      const src = await thumbForFile(fileName);
      if (src) return { src, via: `wikidata ${qid}` };
      notes.push(`wikidata file unresolved (${fileName})`);
    } else notes.push(`wikidata ${qid} has no image`);
  } else notes.push('no wikidata id');

  // 3. First photo used in the article
  const imgs = await getJson('en.wikipedia.org', {
    action: 'query', redirects: '1', prop: 'images', imlimit: '50', titles: page.title,
  });
  const files = (imgs?.query?.pages?.[0]?.images || [])
    .map((i) => String(i.title || '').replace(/^File:/, ''))
    .filter((n) => PHOTO_FILE.test(n) && !NOT_A_PHOTO.test(n));
  // Prefer a file whose name mentions the breed
  const firstWord = page.title.split(/[\s(]/)[0].toLowerCase();
  files.sort((a, b) => Number(b.toLowerCase().includes(firstWord)) - Number(a.toLowerCase().includes(firstWord)));
  for (const f of files.slice(0, 3)) {
    const src = await thumbForFile(f);
    if (src) return { src, via: 'article photo' };
  }
  notes.push(`no usable article photos (${files.length} candidates)`);
  return { reason: notes.join('; '), stop: true };
}

/** Resolve a file name ("Golden Retriever.jpg") to a thumbnail URL. */
async function thumbForFile(fileName) {
  const name = String(fileName).replace(/^File:/i, '').replace(/_/g, ' ');
  // Most photos live on Commons; a few are uploaded locally to English Wikipedia.
  for (const host of ['commons.wikimedia.org', 'en.wikipedia.org']) {
    const data = await getJson(host, {
      action: 'query', prop: 'imageinfo', iiprop: 'url', iiurlwidth: String(THUMB_WIDTH), titles: `File:${name}`,
    });
    const info = data?.query?.pages?.[0]?.imageinfo?.[0];
    const src = info?.thumburl || info?.url;
    if (isWikimediaUrl(src)) return src;
  }
  return null;
}

function isWikimediaUrl(src) {
  // Only ever redirect to Wikimedia's image host (no open redirect).
  return typeof src === 'string' && /^https:\/\/upload\.wikimedia\.org\//.test(src);
}

/** GET a MediaWiki API endpoint as JSON (formatversion 2), with a timeout. */
async function getJson(host, params) {
  const url = new URL(`https://${host}/w/api.php`);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${host} http ${r.status}`);
    return await r.json();
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
