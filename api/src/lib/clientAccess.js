const { getClient, ensureTable } = require('./tables');
const { AuthError } = require('./auth');
const { emailDomain } = require('./domain');
const { genToken, safeTokenEqual } = require('./tokens');

// Client-facing ticket tracking has no account system -- clients aren't
// @jetcityit.com users and ticket submission itself is unauthenticated (no
// email verification), so ticket IDs and email addresses alone can't serve
// as a secret. Instead, each email address gets one persistent random access
// token, stored in the same Tickets table under a dedicated partition, and
// that token is only ever handed out by emailing it TO that address -- never
// returned directly by an API response. Only the real inbox owner ever sees
// it, which is what actually proves the requester owns the address.
const CLIENT_PARTITION = 'CLIENT';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Table Storage RowKeys reject '/', '\\', '#', '?' and control characters --
// none of which are valid in an email address anyway, so a normalized email
// is always safe to use as one directly.
async function getOrCreateClientToken(email) {
  const key = normalizeEmail(email);
  await ensureTable();
  const table = getClient();
  try {
    const row = await table.getEntity(CLIENT_PARTITION, key);
    return row.token;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const token = genToken();
  try {
    await table.createEntity({ partitionKey: CLIENT_PARTITION, rowKey: key, token, createdAt: new Date().toISOString() });
  } catch (e) {
    if (e.statusCode !== 409) throw e;
    // Lost a race with a concurrent request -- read back whichever token it
    // wrote, since either is equally valid to hand out.
    const row = await table.getEntity(CLIENT_PARTITION, key);
    return row.token;
  }
  return token;
}

// Throws AuthError on any mismatch so route handlers can funnel it through
// the existing authErrorResponse() helper without duplicating error shaping.
async function verifyClientToken(email, token) {
  const key = normalizeEmail(email);
  if (!key || !token) throw new AuthError(401, 'Missing email or access token');
  await ensureTable();
  const table = getClient();
  let row;
  try {
    row = await table.getEntity(CLIENT_PARTITION, key);
  } catch (e) {
    if (e.statusCode === 404) throw new AuthError(403, 'Invalid access token');
    throw e;
  }
  if (!safeTokenEqual(row.token, token)) throw new AuthError(403, 'Invalid access token');
  return key;
}

// Ticket volume here is small enough that a full scan filtered in code is
// simpler (and more correct) than an OData filter -- emails aren't stored
// lowercased since submitters type them however they like, and an
// exact-match filter would silently miss case variants of the same address.
async function findTicketsByEmail(email) {
  const key = normalizeEmail(email);
  await ensureTable();
  const table = getClient();
  const metas = [];
  for await (const e of table.listEntities({ queryOptions: { filter: "kind eq 'meta'" } })) {
    if (normalizeEmail(e.email) === key) metas.push(e);
  }
  return metas;
}

// Same scan-and-filter approach as findTicketsByEmail above (see its own
// comment) -- small ticket volume makes an OData filter unnecessary here
// too, and domain isn't its own stored field, so it has to be derived in
// code regardless. Used by the org team-portal (orgPortal.js), where
// visibility is scoped to every ticket from a client's domain rather than
// one specific email.
async function findTicketsByDomain(domain) {
  const key = String(domain || '').trim().toLowerCase();
  await ensureTable();
  const table = getClient();
  const metas = [];
  for await (const e of table.listEntities({ queryOptions: { filter: "kind eq 'meta'" } })) {
    if (emailDomain(e.email) === key) metas.push(e);
  }
  return metas;
}

function buildTrackingLink(email, token, ticketId) {
  const params = new URLSearchParams({ email, token });
  if (ticketId) params.set('ticket', ticketId);
  return `https://helpdesk.jetcityit.com/track.html?${params.toString()}`;
}

module.exports = { normalizeEmail, getOrCreateClientToken, verifyClientToken, findTicketsByEmail, findTicketsByDomain, buildTrackingLink };
