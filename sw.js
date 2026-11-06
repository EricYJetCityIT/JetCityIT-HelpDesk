// Service worker for the installable Help Desk apps (the staff console and the client
// ticket-tracking page both register this one file).
//
// What it does: keeps the app's PAGES loadable when the phone has no signal, without ever
// serving stale app code while there IS a connection. Same approach as the crew-calendar site's
// sw.js. Strategy is NETWORK-FIRST for same-origin GETs: always try the network (so a fresh
// deploy is picked up immediately, exactly as before this file cached anything) and store the
// good response; only if the network fails or takes longer than NET_TIMEOUT_MS is the last
// stored copy used.
//
// What it deliberately does NOT do:
//  - /api/* and every non-GET request are left completely alone. Ticket data, attachments and
//    anything with a token are live data, never cached here.
//  - Cross-origin requests (Microsoft sign-in, Graph, Google Fonts) are untouched, so the
//    sign-in redirect flow behaves exactly as it does in a normal browser tab.
//  - Pages are stored under their path ONLY, never the full URL: the client tracking page is
//    opened with ?email=...&token=... in the address, and a secret must not end up as a cache key
//    (nor should every query variant pile up its own copy).
//
// The cache must never be able to break the site. This worker sits in front of EVERY page it
// controls, and a browser's Cache Storage can fail (a full phone, a corrupted store, and iOS 17.0
// had a bug where caches.match threw "Internal error", which stopped installed apps starting
// when a worker didn't catch it). So every cache call below is isolated: if one throws, the
// request simply carries on over the network as if there were no cache.
const CACHE = 'hd-shell-v1';
const NET_TIMEOUT_MS = 6000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older versions of this file, then take over open pages.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    } catch (e) { /* a cache fault must not stop the worker from activating */ }
    await self.clients.claim();
  })());
});

// The cache key for a request: its URL without the query (see above).
function cacheKeyFor(req) {
  const url = new URL(req.url);
  return url.origin + url.pathname;
}

// Cache helpers that never throw and never reject: a failure just means "no cache".
async function openCache() {
  try { return await caches.open(CACHE); } catch (e) { return null; }
}
async function cacheGet(cache, key) {
  if (!cache) return null;
  try { return (await cache.match(key)) || null; } catch (e) { return null; }
}
function cachePut(cache, key, res) {
  if (!cache) return;
  try { cache.put(key, res).catch(() => {}); } catch (e) { /* ignore */ }
}
function cacheDelete(cache, key) {
  if (!cache) return;
  try { cache.delete(key).catch(() => {}); } catch (e) { /* ignore */ }
}

async function networkFirst(req) {
  const key = cacheKeyFor(req);
  // The cache is opened ALONGSIDE the request, never before it: nothing about Cache Storage may
  // delay, or break, the network fetch.
  const cachePromise = openCache();
  const net = fetch(req).then((res) => {
    // Only keep good same-origin responses (never errors, redirects or opaque responses).
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      cachePromise.then((cache) => cachePut(cache, key, copy));
    }
    return res;
  });
  net.catch(() => {}); // a failure that lands after we've answered from cache is not an error
  let timer;
  const slow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('slow')), NET_TIMEOUT_MS); });
  try {
    const res = await Promise.race([net, slow]);
    if (res && !res.ok && res.type === 'basic' && (res.status >= 500 || res.status === 404)) {
      const cache = await cachePromise;
      const hit = await cacheGet(cache, key);
      if (hit) {
        // A 404 right after a deploy is usually a brief platform blip, so a saved copy is better than an
        // error page. But a page that was really REMOVED must not stay pinned forever by that copy, so on
        // a 404 it is served this once and then dropped: a blip heals on the next load (which stores a
        // fresh copy), a genuinely removed page then 404s as it should. A 5xx is an outage, not a removal,
        // so its saved copy is kept.
        if (res.status === 404) cacheDelete(cache, key);
        return hit;
      }
    }
    return res;
  } catch (e) {
    const cache = await cachePromise;
    const hit = await cacheGet(cache, key);
    if (hit) return hit;
    return net; // nothing saved: wait for the network (or fail the same way it always did)
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // A range request (media) can't be answered from a plain cached 200.
  if (req.headers.has('range')) return;
  event.respondWith(networkFirst(req));
});
