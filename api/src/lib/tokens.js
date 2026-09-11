const crypto = require('crypto');

// Random, server-generated, single-purpose bearer secrets -- a client
// access token (clientAccess.js), a team-portal session/verification token
// (orgUsers.js). Stored plain and compared via a hash-both-sides-then-
// timingSafeEqual check, never a naive !==, which would leak a timing
// signal correlated with how many leading characters a guess got right.
// Unlike a real password these carry no reuse risk, so scrypt would be
// needless cost -- the token's own entropy is the security.
function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function safeTokenEqual(a, b) {
  if (!a || !b) return false;
  const bufA = crypto.createHash('sha256').update(String(a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { genToken, safeTokenEqual };
