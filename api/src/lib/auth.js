const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { checkRateLimit } = require('./ratelimit');

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
const STAFF_UPNS = (process.env.STAFF_UPNS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
  if (!upn.endsWith(ALLOWED_DOMAIN) || !STAFF_UPNS.includes(upn)) {
    throw new AuthError(403, 'Account not permitted');
  }

  const rl = checkRateLimit(upn);
  if (!rl.allowed) {
    throw new AuthError(429, 'Too many requests — please slow down.', { retryAfterSec: rl.retryAfterSec, upn });
  }

  return { name: decoded.name || upn, upn };
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

module.exports = { requireStaff, AuthError, authErrorResponse, STAFF_UPNS };
