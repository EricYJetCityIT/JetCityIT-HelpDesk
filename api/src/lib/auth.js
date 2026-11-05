const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { checkRateLimit } = require('./ratelimit');
const { clientIp } = require('./ip');

const TENANT_ID = process.env.AAD_TENANT_ID;
const CLIENT_ID = process.env.AAD_CLIENT_ID;
// MSAL's acquireTokenSilent issues v1.0 tokens for this app's own "Expose an
// API" scope (unlike the v2.0 tokens Graph scopes get), so the issuer is the
// older sts.windows.net form, not login.microsoftonline.com/v2.0. Same quirk
// as the crew-calendar app, since this reuses that same App Registration.
const ISSUER = `https://sts.windows.net/${TENANT_ID}/`;
const AUDIENCE = `api://${CLIENT_ID}`;
const ALLOWED_DOMAIN = '@jetcityit.com';
const REQUIRED_SCOPE = 'access_as_user';

// Authorization model: unlike the crew-calendar app (everyone @jetcityit.com
// can read, a smaller "editor" tier can write), the help desk staff console
// has no public read tier at all — ticket submission is a separate,
// unauthenticated endpoint (see ticketsPublic.js). Everything under /api/tickets*
// requires being on this allowlist. Same quick-start pattern as the
// crew-calendar app's EDITOR_UPNS: a comma-separated app setting, no
// app-registration change needed to add/remove staff.
//
// AZURE_STAFF_UPNS here is the Azure-setting list ONLY (read-only from the
// site). The allowlist actually enforced is that PLUS the people an access
// admin added from the console's Access tab -- see lib/staffAccess.js, and use
// its getStaffUpns() anywhere that needs "the whole staff team".
const { AZURE_STAFF_UPNS, ACCESS_ADMIN_UPNS, ACCESS_ADMINS_RESTRICTED, getPageStaff } = require('./staffAccess');

const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getSigningKey,
      { issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'] },
      (err, decoded) => (err ? reject(err) : resolve(decoded))
    );
  });
}

class AuthError extends Error {
  constructor(status, message, meta) {
    super(message);
    this.status = status;
    if (meta) Object.assign(this, meta);
  }
}

// Validates the bearer token on an incoming request and enforces both the
// @jetcityit.com restriction and STAFF_UPNS membership.
//
// Reads the token from a custom header, not "Authorization" — Azure Static
// Web Apps' managed-Functions integration reserves that header for its own
// internal SWA-to-Function service token and overwrites whatever the client
// sends, so a client-supplied Authorization header never reaches this code.
async function requireStaff(request) {
  // Every public/client route in this app rate-limits by IP as its first
  // step, before doing any real work. This one didn't: the UPN-keyed limit
  // below only ever runs after a token has already passed full JWT
  // signature/issuer/audience verification, so a flood of garbage/expired
  // bearer tokens got zero throttling. Cheap IP check first closes that gap
  // without weakening the UPN-keyed limit staff themselves are subject to.
  const ip = clientIp(request);
  const ipLimit = checkRateLimit('staff-auth-ip:' + ip, 30, 60 * 1000);
  if (!ipLimit.allowed) {
    throw new AuthError(429, 'Too many requests — please slow down.', { retryAfterSec: ipLimit.retryAfterSec });
  }

  const header = request.headers.get('x-jetcity-authorization') || '';
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) throw new AuthError(401, 'Missing bearer token');

  let decoded;
  try {
    decoded = await verifyToken(match[1]);
  } catch (e) {
    throw new AuthError(401, 'Invalid token: ' + e.message);
  }

  const scopes = String(decoded.scp || '').split(' ');
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new AuthError(403, 'Token missing required scope');
  }

  const upn = String(decoded.preferred_username || decoded.upn || decoded.email || '').toLowerCase();
  if (!upn.endsWith(ALLOWED_DOMAIN)) {
    throw new AuthError(403, 'Account not permitted');
  }

  // Staff = the Azure list OR added on the Access tab. Azure people never need the page list read at
  // all. For anyone else the page list decides, and if it can't be read (and nothing is cached) the
  // honest answer is 503 "try again", not a 403 that would tell a genuinely-added person they have no access.
  const azureStaff = AZURE_STAFF_UPNS.includes(upn);
  if (!azureStaff) {
    const { people, unavailable } = await getPageStaff();
    const grant = people.find((p) => p.upn === upn);
    if (!grant) {
      if (unavailable) throw new AuthError(503, 'Access list is temporarily unavailable. Please try again in a moment.');
      throw new AuthError(403, 'Account not permitted');
    }
    // The grant was made to ONE account (its Entra object id), not to an address. If this address now
    // belongs to someone else -- the person left and the address was reissued, or a rename freed it --
    // they must not inherit the access. A token without an oid claim can't be checked and is let
    // through (every normal user token carries one), so this only ever denies a proven mismatch.
    const tokenOid = String(decoded.oid || '').trim().toLowerCase();
    if (grant.oid && tokenOid && grant.oid !== tokenOid) {
      throw new AuthError(403, 'Account not permitted');
    }
  }

  const rl = checkRateLimit(upn);
  if (!rl.allowed) {
    throw new AuthError(429, 'Too many requests — please slow down.', { retryAfterSec: rl.retryAfterSec, upn });
  }

  // Only people who are staff through AZURE may manage access, so someone added from the page can never
  // hand out access themselves. If ACCESS_ADMIN_UPNS is set it narrows that to the people listed there --
  // and a set-but-unusable value (e.g. just ",") means NOBODY, never "everyone".
  const isAccessAdmin = azureStaff && (!ACCESS_ADMINS_RESTRICTED || ACCESS_ADMIN_UPNS.includes(upn));
  return { name: decoded.name || upn, upn, isAccessAdmin };
}

// Gate for the Access tab's endpoints (list / add / remove people). Depends only on the Azure settings,
// so it never needs the 503 case.
function requireAccessAdmin(user) {
  if (!user || !user.isAccessAdmin) {
    throw new AuthError(403, 'You do not have permission to manage access.');
  }
}

// Azure Static Web Apps' managed Functions integration only supports HTTP
// triggers -- confirmed against Microsoft's own docs after building three
// app.timer(...) functions (SLA escalation, recurring tickets, email
// ingest) that silently never fired, because Timer Triggers aren't
// supported in this hosting model at all. Rather than standing up a
// separate "bring your own Functions" app (a new billable Azure resource
// with its own hosting plan), those three (and the auto-close job added
// since) now run as ordinary HTTP endpoints invoked on a schedule by a
// GitHub Actions workflow instead of by Azure itself. Nobody is signed in when a schedule fires, so this
// can't use requireStaff's JWT flow, and the route can't be left open
// either -- a shared secret (one new INTERNAL_CRON_SECRET app setting,
// matched against a GitHub Actions repo secret of the same value) is the
// simplest fit for "only our own scheduled workflow should be able to
// trigger this."
const INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || '';

function timingSafeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireCronSecret(request) {
  if (!INTERNAL_CRON_SECRET) throw new AuthError(500, 'INTERNAL_CRON_SECRET is not configured');
  const provided = request.headers.get('x-cron-secret') || '';
  if (!provided || !timingSafeEqual(provided, INTERNAL_CRON_SECRET)) {
    throw new AuthError(401, 'Invalid cron secret');
  }
}

function authErrorResponse(e, context) {
  if (e instanceof AuthError) {
    if (e.status === 429) {
      try {
        context.log('RATE_LIMIT ' + JSON.stringify({ upn: e.upn || null, ts: new Date().toISOString() }));
      } catch (_) { /* logging must never break the response */ }
      return {
        status: 429,
        headers: { 'Retry-After': String(e.retryAfterSec || 60) },
        jsonBody: { error: e.message },
      };
    }
    return { status: e.status, jsonBody: { error: e.message } };
  }
  context.error(e);
  return { status: 500, jsonBody: { error: 'Internal server error' } };
}

module.exports = { requireStaff, requireAccessAdmin, requireCronSecret, AuthError, authErrorResponse, AZURE_STAFF_UPNS };
