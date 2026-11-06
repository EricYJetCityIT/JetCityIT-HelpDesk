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
const CACHE = 'hd-shell-v1';
const NET_TIMEOUT_MS = 6000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older versions of this file, then take over open pages.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// The cache key for a request: a page navigation is keyed by its path alone (see above);
// everything else (scripts, images, fonts, the manifest) by its URL without the query.
function cacheKeyFor(req) {
  const url = new URL(req.url);
  return url.origin + url.pathname;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const key = cacheKeyFor(req);
  const net = fetch(req).then((res) => {
    // Only keep good same-origin responses (never errors, redirects or opaque responses).
    if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  net.catch(() => {}); // a failure that lands after we've answered from cache is not an error
  let timer;
  const slow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('slow')), NET_TIMEOUT_MS); });
  try {
    const res = await Promise.race([net, slow]);
    // The host answered but with a server error / transient 404 (seen briefly after deploys):
    // prefer a saved good copy over showing that error.
    if (res && !res.ok && res.type === 'basic' && (res.status >= 500 || res.status === 404)) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    return res;
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) return hit;
    return net; // nothing saved yet: wait for the network (or fail the same way it always did)
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
