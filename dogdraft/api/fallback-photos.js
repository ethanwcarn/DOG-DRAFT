/**
 * GET /api/fallback-photos
 *
 * For breeds without a self-hosted photo (see lib/photos.js), look up a photo
 * in the free Dog API (https://dogapi.dog, images from Wikimedia Commons with
 * attribution) and return:
 *
 *   { photos: { <breedId>: { src, author, license, licenseUrl, sourceUrl } } }
 *
 * The response is cached by Vercel's CDN for a week, so dogapi.dog is called
 * about once a week no matter how many players load the site. Browsers then
 * load the images directly from images.dogapi.dog.
 *
 * Diagnostics: /api/fallback-photos?debug=1 also lists which Dog API breed
 * each of ours matched (or why it didn't). Nothing sensitive is exposed.
 */
import { BREEDS } from '../lib/breeds.js';
import { LOCAL_PHOTOS } from '../lib/photos.js';
import { route, requireMethod, sendJson } from '../lib/http.js';

const API = 'https://dogapi.dog/api/v2/breeds';
const PAGE_SIZE = 100;
const MAX_PAGES = 6; // the API lists ~283 breeds; this is a safety cap
const UA = 'FantasyDogDraft/1.3 (https://dogdraft.ethan-carn.work; private party game)';

/**
 * Extra names to try for our breeds whose Dog API name may differ.
 * Keys are our breed ids; values are alternative names (any spelling).
 */
const ALIASES = {
  'plott-hound': ['Plott', 'Plott Hound'],
  'belgian-sheepdog': ['Belgian Sheepdog', 'Groenendael', 'Belgian Shepherd Dog (Groenendael)', 'Belgian Shepherd Groenendael'],
  'belgian-laekenois': ['Belgian Laekenois', 'Laekenois', 'Belgian Shepherd Laekenois'],
  'russian-tsvetnaya-bolonka': ['Russian Tsvetnaya Bolonka', 'Bolonka', 'Russian Bolonka', 'Tsvetnaya Bolonka'],
  'biewer-terrier': ['Biewer Terrier', 'Biewer Yorkshire Terrier', 'Biewer'],
  'american-eskimo-dog': ['American Eskimo Dog', 'American Eskimo', 'Eskie'],
  'keeshond': ['Keeshond', 'Wolfspitz'],
  'teddy-roosevelt-terrier': ['Teddy Roosevelt Terrier', 'Teddy Roosevelt Rat Terrier'],
  'treeing-walker-coonhound': ['Treeing Walker Coonhound', 'Treeing Walker'],
  'american-hairless-terrier': ['American Hairless Terrier'],
  'toy-fox-terrier': ['Toy Fox Terrier', 'American Toy Terrier'],
  'pomeranian': ['Pomeranian', 'Pom'],
};

/** "Belgian Shepherd Dog (Groenendael)" -> "belgian shepherd groenendael" */
export function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .replace(/\bdog\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isDogApiImage = (u) => typeof u === 'string' && /^https:\/\/images\.dogapi\.dog\//.test(u);

/** Fetch every breed from the Dog API (paginated). */
async function fetchAllBreeds() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${API}?page[number]=${page}&page[size]=${PAGE_SIZE}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let data;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`dogapi page ${page}: http ${r.status}`);
      data = await r.json();
    } finally {
      clearTimeout(timer);
    }
    const items = Array.isArray(data?.data) ? data.data : [];
    all.push(...items);
    if (items.length < PAGE_SIZE || !data?.links?.next) break;
  }
  return all;
}

/**
 * Match our breeds (that lack a local photo) to Dog API breeds and pick one
 * image each. Pure function so it can be unit tested.
 */
export function matchPhotos(ourBreeds, apiBreeds) {
  // Index every Dog API name and alternate name -> breed record
  const index = new Map();
  for (const rec of apiBreeds) {
    const a = rec?.attributes || {};
    const names = [a.name, ...(Array.isArray(a.other_names) ? a.other_names : [])];
    for (const n of names) {
      const k = norm(n);
      if (k && !index.has(k)) index.set(k, rec);
    }
  }
  const photos = {};
  const debug = {};
  for (const b of ourBreeds) {
    const tries = [b.name, b.wiki, ...(ALIASES[b.id] || [])].map(norm).filter(Boolean);
    let rec = null;
    for (const t of tries) {
      rec = index.get(t);
      if (rec) break;
    }
    if (!rec) {
      debug[b.id] = `no Dog API breed named ${[...new Set(tries)].join(' / ')}`;
      continue;
    }
    const images = Array.isArray(rec.attributes?.images) ? rec.attributes.images : [];
    const img = images.find((i) => isDogApiImage(i?.medium) || isDogApiImage(i?.url));
    if (!img) {
      debug[b.id] = `matched "${rec.attributes.name}" but it has no images`;
      continue;
    }
    const at = img.attribution || {};
    photos[b.id] = {
      src: isDogApiImage(img.medium) ? img.medium : img.url,
      author: typeof at.author === 'string' ? at.author.slice(0, 200) : null,
      license: typeof at.license === 'string' ? at.license.slice(0, 100) : null,
      licenseUrl: typeof at.license_url === 'string' && /^https?:\/\//.test(at.license_url) ? at.license_url : null,
      sourceUrl: typeof at.source_url === 'string' && /^https?:\/\//.test(at.source_url) ? at.source_url : null,
    };
    debug[b.id] = `matched "${rec.attributes.name}"`;
  }
  return { photos, debug };
}

export default route(async (req, res) => {
  requireMethod(req, 'GET');
  const debugMode = new URL(req.url, 'http://localhost').searchParams.get('debug') === '1';
  const missing = BREEDS.filter((b) => !LOCAL_PHOTOS.has(b.id));

  let apiBreeds;
  try {
    apiBreeds = await fetchAllBreeds();
  } catch (e) {
    console.warn('fallback-photos: Dog API unavailable:', e.message);
    // Short cache so the next visitor retries soon; the page still works with placeholders.
    return sendJson(res, 200, { photos: {}, error: 'photo service unavailable' }, { 'Cache-Control': 'public, s-maxage=300' });
  }

  const { photos, debug } = matchPhotos(missing, apiBreeds);
  const body = debugMode ? { photos, debug, apiBreedCount: apiBreeds.length } : { photos };
  sendJson(res, 200, body, {
    'Cache-Control': debugMode ? 'no-store' : 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400',
  });
});
