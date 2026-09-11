// Shared by anything that validates or derives a client's email domain --
// assets.js's per-asset client domain, and the org team-portal's per-domain
// accounts (orgUsers.js/orgPortal.js/orgAdmin.js). Loose but sufficient:
// this only needs to catch an obviously malformed value before it becomes
// a Table Storage partition key, not fully validate real-world domain
// syntax.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function isValidDomain(s) {
  return DOMAIN_RE.test(s);
}

function emailDomain(email) {
  const parts = String(email || '').trim().toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : '';
}

module.exports = { isValidDomain, emailDomain };
