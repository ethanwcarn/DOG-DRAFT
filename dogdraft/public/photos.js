/**
 * Breed photos.
 *
 * Most breeds have a self-hosted photo (/breeds/<id>.jpg). For the few that
 * don't, the browser asks Wikipedia/Wikidata/Commons directly (their APIs
 * allow cross-site requests with origin=*), in 3 batched requests total, and
 * caches the answers in localStorage for a week. Any image already on screen
 * is updated in place when its photo arrives. If nothing is found the paw
 * placeholder stays.
 */
import { store } from './dom.js';

const PLACEHOLDER = '/placeholder.svg';
const CACHE_KEY = 'dd_wiki_photos_v1';
const CACHE_MS = 7 * 24 * 3600 * 1000;
const WIDTH = 480;

const local = new Map(); // id -> /breeds/id.jpg
const remote = new Map(); // id -> upload.wikimedia.org url
const wikiTitle = new Map(); // id -> Wikipedia article title

export function initPhotos(breeds) {
  for (const b of breeds) {
    if (b.photo) local.set(b.id, b.photo);
    else wikiTitle.set(b.id, b.wiki);
  }
  const cached = store.get(CACHE_KEY, null);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    for (const [id, url] of Object.entries(cached.urls || {})) if (isWikimedia(url)) remote.set(id, url);
  }
  if (!cached || Date.now() - cached.at >= CACHE_MS) {
    lookupMissing().catch(() => {
      /* offline or blocked: placeholders stay, which is fine */
    });
  }
}

/** Best current URL for a breed photo. */
export function photoSrc(id) {
  return local.get(id) || remote.get(id) || PLACEHOLDER;
}

/** Attributes for an <img> so it can be upgraded later: h('img', { ...photoAttrs(id), alt }) */
export function photoAttrs(id) {
  return { src: photoSrc(id), dataset: { photoId: id } };
}

function isWikimedia(url) {
  return typeof url === 'string' && /^https:\/\/upload\.wikimedia\.org\//.test(url);
}

async function api(host, params) {
  const url = new URL(`https://${host}/w/api.php`);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${host} ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Follow MediaWiki "normalized" and "redirects" mappings from a requested title to the final one. */
function finalTitle(query, title) {
  let t = title;
  for (const n of query?.normalized || []) if (n.from === t) t = n.to;
  for (const r of query?.redirects || []) if (r.from === t) t = r.to;
  return t;
}

async function lookupMissing() {
  const ids = [...wikiTitle.keys()];
  if (!ids.length) return;
  const found = {};

  // 1. Lead-image thumbnails + Wikidata ids, one batched request
  const q1 = await api('en.wikipedia.org', {
    action: 'query', redirects: '1', prop: 'pageimages|pageprops',
    piprop: 'thumbnail', pithumbsize: String(WIDTH), ppprop: 'wikibase_item',
    titles: ids.map((id) => wikiTitle.get(id)).join('|'),
  });
  const pages = new Map((q1?.query?.pages || []).map((p) => [p.title, p]));
  const needWikidata = new Map(); // qid -> id
  for (const id of ids) {
    const page = pages.get(finalTitle(q1.query, wikiTitle.get(id)));
    if (!page) continue;
    if (isWikimedia(page.thumbnail?.source)) found[id] = page.thumbnail.source;
    else if (/^Q\d+$/.test(page.pageprops?.wikibase_item || '')) needWikidata.set(page.pageprops.wikibase_item, id);
  }

  // 2. Wikidata "image" (P18) file names for the rest
  if (needWikidata.size) {
    const wd = await api('www.wikidata.org', { action: 'wbgetentities', ids: [...needWikidata.keys()].join('|'), props: 'claims' });
    const fileFor = new Map(); // "File:Name.jpg" -> id
    for (const [qid, id] of needWikidata) {
      const name = wd?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (typeof name === 'string') fileFor.set(`File:${name}`, id);
    }
    // 3. Resolve file names to thumbnails on Commons
    if (fileFor.size) {
      const c = await api('commons.wikimedia.org', {
        action: 'query', prop: 'imageinfo', iiprop: 'url', iiurlwidth: String(WIDTH), titles: [...fileFor.keys()].join('|'),
      });
      const byTitle = new Map((c?.query?.pages || []).map((p) => [p.title, p]));
      for (const [title, id] of fileFor) {
        const info = byTitle.get(finalTitle(c.query, title))?.imageinfo?.[0];
        const src = info?.thumburl || info?.url;
        if (isWikimedia(src)) found[id] = src;
      }
    }
  }

  for (const [id, url] of Object.entries(found)) remote.set(id, url);
  store.set(CACHE_KEY, { at: Date.now(), urls: found });
  // Upgrade any images already on screen
  for (const [id, url] of Object.entries(found)) {
    document.querySelectorAll(`img[data-photo-id="${CSS.escape(id)}"]`).forEach((img) => {
      img.src = url;
    });
  }
}
