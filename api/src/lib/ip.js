// The FIRST (leftmost) X-Forwarded-For entry is whatever the client itself
// claimed -- attacker-controlled, not trustworthy. Per the standard
// multi-hop proxy convention (each hop APPENDS the peer address it
// observed, it doesn't overwrite what's already there), the entry closest
// to Azure's own edge -- and therefore the one worth keying rate limits on
// -- is the LAST one, not the first.
function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

module.exports = { clientIp };
