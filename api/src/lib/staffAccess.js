const { getClient, ensureTable } = require('./tables');

// Who may use the staff console = the people listed in the STAFF_UPNS Azure
// app setting PLUS anyone an access admin added from the console's Access tab.
// The page-added people live as one row each under a reserved 'ACCESS'
// partition of the Tickets table (never in code: this is staff data and the
// repo is public). They are ADDED to the Azure list at sign-in time, so
// removing someone on the page never removes anyone who is still in the Azure
// setting, and a failed read of these rows can only ever fall back to the
// Azure list. Same model as the crew site's Access tab; the site never writes
// Azure settings itself.
//
// kind is 'access', deliberately not 'meta', so these rows never surface in
// ticketsList's kind==='meta' filter, and every ticket route's "must have a
// real meta row" check already refuses to touch the partition (same
// protection CLIENT/CONFIG/RECURRING/EMAILDEDUP rely on). The RowKey is the
// lowercased UPN, never '0', so it can't collide with a ticket meta row.
//
// A row also remembers the Entra object id (`oid`) of the account it was
// granted to, and requireStaff insists the signed-in token carries that same
// oid. Without it a grant is just an address: if that person leaves and the
// same address is later issued to someone else (or an old address is freed by
// a rename), the new holder would silently inherit console access.
const PARTITION = 'ACCESS';
const KIND = 'access';
const MAX_PAGE_STAFF = 100;
const TTL_MS = 30 * 1000;            // how long one server instance trusts what it read
const RETRY_MS = 5 * 1000;           // after a failed read, wait this long before trying again
const READ_TIMEOUT_MS = 2500;        // never hold a request on a slow Table read longer than this
const MAX_STALE_MS = 10 * 60 * 1000; // a last-good copy is not trusted longer than this when reads keep failing
const UPN_RE = /^[a-z0-9][a-z0-9._%+'-]{0,63}@jetcityit\.com$/;

const normUpn = (s) => String(s == null ? '' : s).trim().toLowerCase();
const validUpn = (s) => UPN_RE.test(normUpn(s));
const parseList = (s) => String(s || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);

// The people set in Azure (STAFF_UPNS). Read-only from the site.
const AZURE_STAFF_UPNS = parseList(process.env.STAFF_UPNS);
// OPTIONAL: narrows who may manage the Access tab. Unset/blank => everyone who
// is staff through Azure may. Set => ONLY the people listed here (who must
// also be Azure staff). Someone added from the page can NEVER manage access,
// so a granted person can't hand out access themselves.
const ACCESS_ADMIN_RAW = String(process.env.ACCESS_ADMIN_UPNS || '');
const ACCESS_ADMIN_UPNS = parseList(ACCESS_ADMIN_RAW);
// "Set" is judged on the raw value, not on how many addresses parsed out of it:
// a value that is present but unusable (just ",", or a typo'd list) must leave
// NOBODY able to manage access (fail closed, fix it in Azure), not silently
// widen to every Azure staff member.
const ACCESS_ADMINS_RESTRICTED = ACCESS_ADMIN_RAW.trim() !== '';

// All page-added rows. Throws on any failure, so callers can tell "nobody was
// added" from "couldn't read". Not capped here: the cap is enforced when
// ADDING, and if two admins race past it every row must still be visible and
// removable, not silently dropped from the list while still granting nothing.
async function readPageStaff() {
  await ensureTable();
  const people = [];
  for await (const e of getClient().listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } })) {
    if (e.kind !== KIND) continue;
    const upn = normUpn(e.rowKey);
    if (!validUpn(upn)) continue;
    people.push({ upn, name: e.name || null, oid: normUpn(e.oid), addedBy: e.addedBy || null, addedAt: e.addedAt || null });
  }
  people.sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')) || a.upn.localeCompare(b.upn));
  return people;
}

let cache = null, cacheAt = 0, retryAt = 0, inflight = null, gen = 0;

// Waiting callers give up after READ_TIMEOUT_MS, but the read itself keeps going: if it finishes late
// it still fills the cache (unless a change happened meanwhile), so the next request is served from it.
function readWithTimeout(g) {
  let timer;
  const read = readPageStaff();
  read.then((people) => { if (g === gen) { cache = people; cacheAt = Date.now(); retryAt = 0; } }, () => {});
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('access read timed out')), READ_TIMEOUT_MS); });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

// The page-added people for the sign-in check: { people, unavailable }. It NEVER throws.
//  - Cached per instance for 30 s: at most one Table read per 30 s, not one per request.
//  - Concurrent callers share ONE read, and a read gives up after 2.5 s, so a slow Table can't pile
//    every request up behind it.
//  - If a read fails, the last good copy keeps being used (for up to 10 minutes) and the next try is
//    ~5 s later, also when there is no good copy yet.
//  - `unavailable` is true only when a read failed and there is NOTHING cached: the Azure list still
//    applies, but "not added on the page" can't be told from "couldn't check" (requireStaff answers 503,
//    not 403, to someone who needs the page list).
async function getPageStaff() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return { people: cache, unavailable: false };
  if (now >= retryAt) {
    if (!inflight) {
      const g = gen;
      // Cleared only if it is still THIS read: a change in between can start a newer one, which an
      // older read finishing late must not wipe out (that would allow duplicate concurrent reads).
      const p = readWithTimeout(g).then(
        (people) => people,
        (e) => {
          retryAt = Date.now() + RETRY_MS;
          console.warn('STAFF_ACCESS_READ_FAILED ' + String((e && e.message) || e).slice(0, 160));
          return null;
        }
      ).finally(() => { if (inflight === p) inflight = null; });
      inflight = p;
    }
    const fresh = await inflight;
    if (fresh) return { people: fresh, unavailable: false };
  }
  return cache && Date.now() - cacheAt < MAX_STALE_MS ? { people: cache, unavailable: false } : { people: [], unavailable: true };
}

// After this instance changes the list, the new list IS the truth here: use it straight away. Other
// instances pick the change up within TTL_MS.
function primePageStaff(people) { gen++; cache = people; cacheAt = Date.now(); retryAt = 0; inflight = null; }

// Re-reads after a change so this instance serves the new list immediately. Several changes can overlap
// on one instance, and their re-reads can finish out of order, so each carries a sequence number (taken
// AFTER its own write) and only the newest re-read seen so far may replace the cache -- an older
// snapshot landing last would otherwise bring a just-removed person back for a while.
//
// The change itself has already been written by now, so a failed re-read must not fail the request.
// Instead the change is applied to the copy this instance already had, and that copy is marked due for
// a re-read (but stays usable as the fallback). Dropping it instead would 503 every non-Azure staff
// member on this instance until a read succeeds; keeping it unchanged would be wrong in the one case
// that matters (a removal).
// `delta` is { add: row } or { remove: upn }, or null when nothing actually changed (a duplicate add).
let changeSeq = 0, primedSeq = 0;
async function refreshAfterChange(delta) {
  const seq = ++changeSeq;
  let timer;
  try {
    // Bounded like every other read here: the change is already saved, so a slow Table must not keep
    // the admin's request hanging -- it falls through to applying the change locally below.
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('access refresh timed out')), READ_TIMEOUT_MS); });
    const people = await Promise.race([readPageStaff(), timeout]);
    if (seq > primedSeq) { primedSeq = seq; primePageStaff(people); }
  } catch (e) {
    gen++; retryAt = 0; inflight = null;
    if (cache && seq > primedSeq) {
      if (delta && delta.add) cache = cache.filter((p) => p.upn !== delta.add.upn).concat([delta.add]);
      else if (delta && delta.remove) cache = cache.filter((p) => p.upn !== delta.remove);
      cacheAt = Date.now() - TTL_MS;
    } else if (!cache) {
      cacheAt = 0;
    }
  } finally {
    clearTimeout(timer);
  }
}

// Everyone who is staff right now: the Azure list first, then page-added people in the order they were
// added, de-duplicated. For everything that needs "the staff team" (assignee dropdown and validation,
// round-robin auto-assignment, broadcast emails). Never throws.
async function getStaffUpns() {
  const { people } = await getPageStaff();
  return Array.from(new Set(AZURE_STAFF_UPNS.concat(people.map((p) => p.upn))));
}

// Adds one person. `person` = { upn, name, oid }, already validated against the directory by the caller.
// Returns true if newly added, false if they were already on the page list. createEntity is the
// "already there" check (409), so two admins adding the same person can't double-write.
async function addPageStaff(person, addedBy) {
  await ensureTable();
  const existing = await readPageStaff();
  if (existing.length >= MAX_PAGE_STAFF && !existing.some((p) => p.upn === person.upn)) throw new Error('Too many people');
  const row = { upn: person.upn, name: person.name || null, oid: normUpn(person.oid), addedBy: addedBy || null, addedAt: new Date().toISOString() };
  try {
    await getClient().createEntity({
      partitionKey: PARTITION,
      rowKey: row.upn,
      kind: KIND,
      name: row.name || '',
      oid: row.oid,
      addedBy: row.addedBy || '',
      addedAt: row.addedAt,
    });
  } catch (e) {
    if (e.statusCode === 409) { await refreshAfterChange(null); return false; }
    throw e;
  }
  await refreshAfterChange({ add: row });
  return true;
}

// Removes one page-added person. Returns false if they weren't on the page list.
async function removePageStaff(upn) {
  await ensureTable();
  const target = normUpn(upn);
  try {
    await getClient().deleteEntity(PARTITION, target);
  } catch (e) {
    if (e.statusCode === 404) return false;
    throw e;
  }
  await refreshAfterChange({ remove: target });
  return true;
}

module.exports = {
  AZURE_STAFF_UPNS,
  ACCESS_ADMIN_UPNS,
  ACCESS_ADMINS_RESTRICTED,
  MAX_PAGE_STAFF,
  normUpn,
  validUpn,
  readPageStaff,
  getPageStaff,
  getStaffUpns,
  addPageStaff,
  removePageStaff,
};
