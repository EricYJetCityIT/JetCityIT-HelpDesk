const crypto = require('crypto');
const { getClient, ensureTable } = require('./tables');
const { AuthError } = require('./auth');
const { getStaffUpns } = require('./staffAccess');
const { SUPPORT_MAILBOX } = require('./graph');
const { odataEscape } = require('./odata');

// Push notifications for the installed phone apps (the staff console and the client tracking page).
//
// How it works, end to end: a phone that has turned alerts on hands the browser's push service
// (Google/Apple/Mozilla/Microsoft) a "subscription" -- an address that only this server's signing key
// may post to -- and we keep that address here. When something happens on a ticket we post a small
// message to each address; the push service wakes the phone and the app's service worker (sw.js) shows it.
// Nothing here ever carries a ticket's message text: only the title, the ticket's subject, and a link.
//
// Storage: one row per subscribed DEVICE in the Tickets table, under a reserved partition per audience
// (kind 'push' -- never 'meta', so it never appears as a ticket; every scan of this table filters by kind
// or by partition). Staff rows live apart from client rows so that a broadcast to the team only ever
// reads rows that were written by signed-in staff.
//   PartitionKey 'PUSH-STAFF' | 'PUSH-CLIENT'
//   RowKey       sha256(endpoint)  -- one row per device, which also means ONE identity per device: if
//                a phone is handed to someone else and they turn alerts on, the row moves to them and
//                the previous person stops receiving that phone's alerts (never the other way round).
//   identity     the staff member's address / the client's email, lowercased
//
// The signing key pair (VAPID) is generated on first use and kept in one CONFIG row, so there is no
// secret for anyone to paste into Azure. Deleting that row makes every existing subscription invalid
// (the pages notice and re-register themselves the next time they are opened).
const PARTITIONS = { staff: 'PUSH-STAFF', client: 'PUSH-CLIENT' };
const MAX_DEVICES = { staff: 8, client: 4 };   // per person; the oldest is dropped to make room
const CONFIG_PARTITION = 'CONFIG';
const VAPID_ROW = 'vapid';

// Alerts are sent from inside request handlers (a ticket being created, a reply being saved), and Azure
// Static Web Apps cuts every API request at 45 seconds, so the whole fan-out has a hard stop well inside
// that: a push service that is slow or down can delay the page by a few seconds at most, never hang it.
const SEND_TIMEOUT_MS = 4000;       // one push-service request
const BATCH_DEADLINE_MS = 5000;     // everything for one event
const MAX_SENDS_PER_EVENT = 100;
const STAFF_TTL_S = 6 * 60 * 60;    // a phone that is off for longer than this skips the (now stale) alert
const CLIENT_TTL_S = 24 * 60 * 60;

// The web-push library is loaded the first time it is needed, NOT when this file is loaded. Azure Functions
// loads every function file at startup, and this file is pulled in by the ticket code: a require at the top
// would turn a problem with that one package (a failed install, a bad version) into an API that won't start at
// all. This way the worst case is that alerts don't go out -- every caller of this file already carries on
// when an alert fails.
let webpushLib = null;
function webpush() {
  if (!webpushLib) webpushLib = require('web-push');
  return webpushLib;
}

const lower = (s) => String(s || '').trim().toLowerCase();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeLog(context, msg) {
  try { context.log(msg); } catch (e) { /* logging must never break a notification path */ }
}

// ---------------------------------------------------------------------------------------------
// What a subscription may look like
// ---------------------------------------------------------------------------------------------

// This server will POST to whatever address a subscriber hands it, so the address must be one of the
// real push services, over HTTPS, and nothing else -- otherwise a signed-up "device" could point the
// server at any host it can reach (a request-forgery hole). These are the services browsers actually
// use: Chrome/Edge/Android -> FCM, Safari/iPhone -> Apple, Firefox -> Mozilla autopush, and the Windows
// notification service.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com']);
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com'];

function isAllowedEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (PUSH_HOSTS.has(host)) return true;
  return PUSH_HOST_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}

function b64urlBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  try { return Buffer.from(s, 'base64url'); } catch (e) { return null; }
}

// Returns the three things needed to send to a device, in canonical form, or null if anything is off.
// p256dh is an uncompressed P-256 public key (65 bytes, leading 0x04) and auth is a 16-byte secret.
function parseSubscription(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const endpoint = raw.endpoint;
  if (!isAllowedEndpoint(endpoint)) return null;
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const p256dh = b64urlBytes(keys.p256dh);
  const auth = b64urlBytes(keys.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return null;
  if (!auth || auth.length !== 16) return null;
  return { endpoint, p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') };
}

// ---------------------------------------------------------------------------------------------
// The signing key pair
// ---------------------------------------------------------------------------------------------

let vapidCache = null;

async function getVapid() {
  if (vapidCache) return vapidCache;
  await ensureTable();
  const table = getClient();
  let row = null;
  try {
    row = await table.getEntity(CONFIG_PARTITION, VAPID_ROW);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  if (!row) {
    const keys = webpush().generateVAPIDKeys();
    try {
      await table.createEntity({
        partitionKey: CONFIG_PARTITION,
        rowKey: VAPID_ROW,
        kind: 'config',
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        createdAt: new Date().toISOString(),
      });
      row = keys;
    } catch (e) {
      if (e.statusCode !== 409) throw e;
      // Another instance generated its pair at the same moment and won: use theirs, never both.
      row = await table.getEntity(CONFIG_PARTITION, VAPID_ROW);
    }
  }
  if (typeof row.publicKey !== 'string' || typeof row.privateKey !== 'string' || !row.publicKey || !row.privateKey) {
    throw new Error('The stored push signing key is unreadable');
  }
  // The "subject" tells a push service who to contact about this sender; it has to be a mailto: or https: address.
  vapidCache = { subject: 'mailto:' + SUPPORT_MAILBOX, publicKey: row.publicKey, privateKey: row.privateKey };
  return vapidCache;
}

async function getPublicKey() {
  return (await getVapid()).publicKey;
}

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

function partitionFor(audience) {
  const p = PARTITIONS[audience];
  if (!p) throw new Error('Unknown push audience');
  return p;
}

async function listRows(partition, identity) {
  await ensureTable();
  const table = getClient();
  let filter = `PartitionKey eq '${partition}'`;
  if (identity) filter += ` and identity eq '${odataEscape(identity)}'`;
  const rows = [];
  for await (const e of table.listEntities({ queryOptions: { filter } })) rows.push(e);
  return rows;
}

// Saves (or refreshes) a device for `identity`. Called when alerts are turned on and again, silently,
// whenever an installed app is opened, which is also how a device that has moved to a new push address
// gets its row updated. Throws AuthError(400) for a registration that isn't a real one.
async function saveSubscription(audience, identity, rawSubscription, context) {
  const partition = partitionFor(audience);
  const id = lower(identity);
  if (!id) throw new AuthError(400, 'Missing identity');
  const sub = parseSubscription(rawSubscription);
  if (!sub) throw new AuthError(400, 'That device registration is not valid.');

  await ensureTable();
  const table = getClient();
  const rowKey = sha256(sub.endpoint);
  const now = new Date().toISOString();

  let existing = null;
  try {
    existing = await table.getEntity(partition, rowKey);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const sameOwner = !!existing && existing.identity === id;
  if (existing && !sameOwner) safeLog(context, 'PUSH_DEVICE_REASSIGNED ' + JSON.stringify({ audience }));

  if (!sameOwner) {
    // A new device for this person: keep them under the cap by retiring the one not seen for longest.
    const cap = MAX_DEVICES[audience];
    const mine = (await listRows(partition, id)).filter((r) => r.rowKey !== rowKey);
    if (mine.length >= cap) {
      mine.sort((a, b) => String(a.lastSeenAt || '').localeCompare(String(b.lastSeenAt || '')));
      for (const r of mine.slice(0, mine.length - cap + 1)) {
        await table.deleteEntity(partition, r.rowKey).catch(() => {});
      }
    }
  }

  // The same browser can't be a staff device and a client device at once: it has ONE push address for the
  // whole site, so registering it here retires its row under the other audience. (Otherwise a phone that was
  // a staff member's and is now signed in on the client page would keep receiving staff alerts.)
  const otherPartition = PARTITIONS[audience === 'staff' ? 'client' : 'staff'];
  await table.deleteEntity(otherPartition, rowKey).catch((e) => {
    if (e.statusCode !== 404) safeLog(context, 'PUSH_OTHER_AUDIENCE_CLEANUP_FAILED ' + JSON.stringify({ status: e.statusCode }));
  });

  await table.upsertEntity({
    partitionKey: partition,
    rowKey,
    kind: 'push',
    identity: id,
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    createdAt: sameOwner && existing.createdAt ? existing.createdAt : now,
    lastSeenAt: now,
  }, 'Replace');
}

// Removes ONE device, and only if it belongs to `identity` -- knowing a device's address is not enough
// to switch someone else's alerts off. Idempotent: an unknown device is not an error.
async function removeSubscription(audience, identity, endpoint) {
  const partition = partitionFor(audience);
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1000) return false;
  await ensureTable();
  const table = getClient();
  const rowKey = sha256(endpoint);
  let row;
  try {
    row = await table.getEntity(partition, rowKey);
  } catch (e) {
    if (e.statusCode === 404) return false;
    throw e;
  }
  if (row.identity !== lower(identity)) return false;
  await table.deleteEntity(partition, rowKey).catch((e) => {
    if (e.statusCode !== 404) throw e;
  });
  return true;
}

// Removes every device a person has -- used when someone is taken off the staff list.
async function removeAllSubscriptions(audience, identity) {
  const partition = partitionFor(audience);
  const rows = await listRows(partition, lower(identity));
  const table = getClient();
  for (const r of rows) await table.deleteEntity(partition, r.rowKey).catch(() => {});
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// The only fields that ever leave this server: a title, one short line, the page to open, and a tag
// that lets a newer alert about the same ticket replace the older one on the lock screen.
function shape(payload) {
  const p = payload || {};
  return JSON.stringify({
    title: clip(p.title || 'Jet City IT Help Desk', 80),
    body: clip(p.body, 140),
    url: typeof p.url === 'string' && p.url.startsWith('/') && !p.url.startsWith('//') ? p.url.slice(0, 300) : '/',
    tag: p.tag ? clip(p.tag, 80) : '',
  });
}

function staffTicketPush(title, ticketId, subject) {
  return { title, body: subject, url: '/staff.html?ticket=' + encodeURIComponent(ticketId), tag: 'ticket-' + ticketId };
}
// No credentials in this link: the client app already holds its person's sign-in on the phone.
function clientTicketPush(title, ticketId, subject) {
  return { title, body: subject, url: '/track.html?ticket=' + encodeURIComponent(ticketId), tag: 'ticket-' + ticketId };
}

// Sends to every row. Never throws and never waits longer than BATCH_DEADLINE_MS. A device whose push
// address has expired (the push service answers 404/410) is deleted; every other failure -- an outage,
// a timeout, a rejected key -- leaves the row alone so that one bad hour can't wipe everyone's alerts.
async function deliver(context, rows, payload, ttl) {
  const stats = { devices: rows.length, sent: 0, gone: 0, failed: 0 };
  if (!rows.length) return stats;
  let vapid;
  try {
    vapid = await getVapid();
  } catch (e) {
    safeLog(context, 'PUSH_KEY_UNAVAILABLE ' + JSON.stringify({ error: String(e.message).slice(0, 200) }));
    stats.failed = rows.length;
    return stats;
  }
  const body = shape(payload);
  const table = getClient();
  const batch = rows.slice(0, MAX_SENDS_PER_EVENT);
  stats.failed += rows.length - batch.length;

  const work = batch.map(async (row) => {
    // Re-checked at send time too, in case a row was ever written some other way.
    if (!isAllowedEndpoint(row.endpoint)) { stats.failed++; return; }
    try {
      await webpush().sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { vapidDetails: vapid, TTL: ttl, urgency: 'high', timeout: SEND_TIMEOUT_MS }
      );
      stats.sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        stats.gone++;
        await table.deleteEntity(row.partitionKey, row.rowKey).catch(() => {});
      } else {
        stats.failed++;
      }
    }
  });

  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, BATCH_DEADLINE_MS); });
  await Promise.race([Promise.allSettled(work), deadline]);
  clearTimeout(timer);
  safeLog(context, 'PUSH_DELIVERED ' + JSON.stringify(stats));
  return stats;
}

// Alert staff devices. `only` limits it to those people; `exclude` leaves some out (the person who just
// did the thing). Only people who are staff RIGHT NOW are alerted: someone taken off the list stops
// receiving alerts immediately, whether or not their phone's row has been cleaned up yet.
async function pushToStaff(context, payload, opts) {
  try {
    const o = opts || {};
    const staff = new Set(await getStaffUpns());
    const only = Array.isArray(o.only) ? new Set(o.only.map(lower)) : null;
    const exclude = new Set((Array.isArray(o.exclude) ? o.exclude : []).map(lower));
    const rows = (await listRows(PARTITIONS.staff)).filter(
      (r) => staff.has(r.identity) && !exclude.has(r.identity) && (!only || only.has(r.identity))
    );
    return await deliver(context, rows, payload, STAFF_TTL_S);
  } catch (e) {
    safeLog(context, 'PUSH_STAFF_FAILED ' + JSON.stringify({ error: String(e && e.message).slice(0, 200) }));
    return { devices: 0, sent: 0, gone: 0, failed: 0 };
  }
}

// Alert one client's devices (by the email their tracking link belongs to).
async function pushToClient(context, email, payload) {
  try {
    const id = lower(email);
    if (!id) return { devices: 0, sent: 0, gone: 0, failed: 0 };
    return await deliver(context, await listRows(PARTITIONS.client, id), payload, CLIENT_TTL_S);
  } catch (e) {
    safeLog(context, 'PUSH_CLIENT_FAILED ' + JSON.stringify({ error: String(e && e.message).slice(0, 200) }));
    return { devices: 0, sent: 0, gone: 0, failed: 0 };
  }
}

// "Send me a test": reports how many of the caller's own devices were reached.
async function sendTest(audience, identity, context) {
  const rows = await listRows(partitionFor(audience), lower(identity));
  const url = audience === 'staff' ? '/staff.html' : '/track.html';
  return deliver(context, rows, { title: 'Alerts are working', body: 'You will get a notification like this when there is news on a ticket.', url, tag: 'test' }, 5 * 60);
}

module.exports = {
  isAllowedEndpoint,
  parseSubscription,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  removeAllSubscriptions,
  pushToStaff,
  pushToClient,
  sendTest,
  staffTicketPush,
  clientTicketPush,
};
