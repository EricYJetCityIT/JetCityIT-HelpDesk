const crypto = require('crypto');
const { TableClient } = require('@azure/data-tables');
const { emailDomain: getEmailDomain, isValidDomain } = require('./domain');
const { genToken, safeTokenEqual } = require('./tokens');

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TABLE_NAME = 'OrgUsers';

// A separate Table Storage table from Tickets/Assets, not a reserved
// partition inside either -- same reasoning as Assets (see assetsTable.js):
// this data has its own shape/lifecycle entirely (team-portal accounts and
// per-domain enablement, not tickets or hardware), and a dedicated table
// avoids any risk of a crafted value ever colliding with an existing
// reserved partition name.
//
// PartitionKey = the client's email domain (lowercased) -- the same domain
// string Assets already partitions by and the ticket sidebar groups by.
// Within one domain's partition:
//   RowKey '_enabled' -- a sentinel row, written only once staff opts a
//     domain into the team portal (setDomainEnabled). Its absence is what
//     blocks signup for a domain nobody has turned this on for.
//   RowKey <lowercased email> -- a real account row: name, passwordHash,
//     verified, verifyToken (while unverified), sessionToken (while
//     signed in, '' otherwise), createdAt/verifiedAt.
let client;
let ensured;
function getClient() {
  if (!client) {
    if (!CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
    client = TableClient.fromConnectionString(CONNECTION_STRING, TABLE_NAME);
  }
  return client;
}

async function ensureTable() {
  if (!ensured) {
    ensured = getClient()
      .createTable()
      .catch((e) => {
        if (e.statusCode !== 409) throw e;
      });
  }
  return ensured;
}

const ENABLED_ROW_KEY = '_enabled';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailDomain(email) {
  return getEmailDomain(email);
}

// --- Password hashing (scrypt, salted) --------------------------------
// Real, user-chosen, reused-elsewhere-risk passwords get salted+hashed --
// unlike the random bearer tokens below, a password's own entropy can't
// be trusted, so it's never stored or compared directly.
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(salt.toString('hex') + ':' + derivedKey.toString('hex'));
    });
  });
}

// Buffer.from(str, 'hex') never throws on malformed hex (it silently stops
// at the first invalid pair) -- the length check below is what actually
// guards against a malformed `stored` value, not a try/catch.
function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || '').split(':');
    if (parts.length !== 2) return resolve(false);
    const salt = Buffer.from(parts[0], 'hex');
    const expected = Buffer.from(parts[1], 'hex');
    if (!salt.length || !expected.length) return resolve(false);
    crypto.scrypt(password, salt, expected.length, (err, derivedKey) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(derivedKey, expected));
    });
  });
}

// A validly-shaped (not a real derivation of anything) hash used to run
// login's password check with the SAME cost even when no account exists
// for the given email -- otherwise a nonexistent email would respond
// measurably faster than a real one with a wrong password, letting an
// attacker enumerate valid team-portal emails by timing alone.
const DUMMY_PASSWORD_HASH = '00'.repeat(16) + ':' + '00'.repeat(64);

// A session token is a much higher-value credential than the individual
// client portal's equivalent (it grants an entire client organization's
// ticket history, not one person's own tickets), so unlike that one it
// doesn't stay valid forever -- orgPortal.js's requireOrgSession rejects
// one older than this, forcing a fresh sign-in periodically even if it
// was never explicitly logged out or leaked.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function isDomainEnabled(domain) {
  await ensureTable();
  const table = getClient();
  try {
    const row = await table.getEntity(domain, ENABLED_ROW_KEY);
    return !!row.enabled;
  } catch (e) {
    if (e.statusCode === 404) return false;
    throw e;
  }
}

async function setDomainEnabled(domain, enabled, staffUpn) {
  await ensureTable();
  const table = getClient();
  await table.upsertEntity(
    {
      partitionKey: domain,
      rowKey: ENABLED_ROW_KEY,
      enabled: !!enabled,
      updatedBy: staffUpn || '',
      updatedAt: new Date().toISOString(),
    },
    'Merge'
  );
}

// Disabling/re-enabling one account -- the reversible, per-person
// counterpart to setDomainEnabled above. Disabling also clears the
// session token/timestamp immediately (not just relying on the live
// `disabled` check in requireOrgSession), so re-enabling the account
// later can never silently revive a session that was valid before the
// disable -- getting back in always requires a fresh sign-in.
async function setAccountDisabled(domain, email, disabled, staffUpn) {
  await ensureTable();
  const table = getClient();
  const update = {
    partitionKey: domain,
    rowKey: normalizeEmail(email),
    disabled: !!disabled,
    disabledBy: staffUpn || '',
    disabledAt: new Date().toISOString(),
  };
  if (disabled) {
    update.sessionToken = '';
    update.sessionIssuedAt = '';
  }
  await table.updateEntity(update, 'Merge');
}

async function getAccount(email) {
  const domain = emailDomain(email);
  // isValidDomain guards every caller (signup/login/verify/resend/session
  // checks all go through this) against a malformed domain ever reaching
  // Table Storage as a partition key -- without it, an email like
  // "a@ev/il.com" would throw an uncaught RestError instead of cleanly
  // resolving to "no such account", the same as any other not-found email.
  if (!domain || !isValidDomain(domain)) return null;
  await ensureTable();
  const table = getClient();
  try {
    return await table.getEntity(domain, normalizeEmail(email));
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

// Permanently removes one account -- used by staff to cut off a single
// departed/compromised person without disabling the whole domain (see
// setDomainEnabled for the domain-wide lever). Deleting the row invalidates
// both the account's session token and its password in one step.
async function deleteAccount(domain, email) {
  await ensureTable();
  const table = getClient();
  await table.deleteEntity(domain, normalizeEmail(email)).catch((e) => {
    if (e.statusCode !== 404) throw e;
  });
}

// Full-table scan grouped by partition -- same "fine at this volume"
// trade-off this app already accepts for ticketsList/findAssetById; a
// staff-only admin listing, not a hot path.
async function listAllDomainsWithAccounts() {
  await ensureTable();
  const table = getClient();
  const byDomain = new Map();
  for await (const e of table.listEntities({ queryOptions: {} })) {
    const domain = e.partitionKey;
    if (!byDomain.has(domain)) byDomain.set(domain, { domain, enabled: false, accounts: [] });
    const entry = byDomain.get(domain);
    if (e.rowKey === ENABLED_ROW_KEY) {
      entry.enabled = !!e.enabled;
    } else {
      entry.accounts.push({
        email: e.rowKey,
        name: e.name,
        verified: !!e.verified,
        disabled: !!e.disabled,
        createdAt: e.createdAt,
      });
    }
  }
  return Array.from(byDomain.values()).sort((a, b) => a.domain.localeCompare(b.domain));
}

module.exports = {
  getClient,
  ensureTable,
  normalizeEmail,
  emailDomain,
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
  SESSION_MAX_AGE_MS,
  genToken,
  safeTokenEqual,
  isDomainEnabled,
  setDomainEnabled,
  getAccount,
  setAccountDisabled,
  deleteAccount,
  listAllDomainsWithAccounts,
};
