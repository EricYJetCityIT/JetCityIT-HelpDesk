// Thin wrapper around the Smartsheet REST API (https://api.smartsheet.com/2.0).
// Auth is a single shared Personal Access Token (SMARTSHEET_API_TOKEN app
// setting) for the whole help desk team, not per-staff OAuth -- Smartsheet's
// own docs recommend a PAT (not per-user OAuth) for exactly this case: one
// internal tool acting on behalf of one team, not a multi-tenant integration.
// Same "one shared credential" shape as MAIL_CLIENT_SECRET/graph.js elsewhere
// in this app.
const SMARTSHEET_API_BASE = 'https://api.smartsheet.com/2.0';
const CACHE_MS = 5 * 60 * 1000; // sheet list changes more than staff names do, so a shorter TTL than staffList's 30 min
const MAX_LINKED_SHEETS = 5;

class SmartsheetError extends Error {}

let cache = null; // { data, expiresAt }

function getToken() {
  const token = process.env.SMARTSHEET_API_TOKEN;
  if (!token) throw new SmartsheetError('Smartsheet is not connected yet (SMARTSHEET_API_TOKEN is not configured)');
  return token;
}

async function fetchSheetsFromApi() {
  const token = getToken();
  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets?includeAll=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SmartsheetError(`Smartsheet API error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  // Each sheet's `permalink` is a direct, ready-to-open browser URL to that
  // sheet -- Smartsheet's List Sheets response already includes it, so no
  // extra per-sheet lookup is needed just to get a link staff can click. It's
  // rendered as a live <a href>, shown to clients too (not just staff), so
  // its scheme/host is validated here rather than trusted blindly -- the
  // same "never trust an external response shape" reasoning already applied
  // to attachment content-type sniffing elsewhere in this app. A sheet
  // failing this check is dropped rather than surfaced with a broken link.
  return (data.data || [])
    .filter((s) => typeof s.permalink === 'string' && /^https:\/\/app\.smartsheet\.com\//.test(s.permalink))
    .map((s) => ({ id: String(s.id), name: s.name, permalink: s.permalink }));
}

// Cached list of every sheet the shared service account can see. Shared by
// the reply box's picker (GET /api/smartsheet/sheets) and
// resolveLinkedSheets's validation of which sheet ids are real, so both
// normally agree on the same data without a duplicate Smartsheet round-trip
// per reply. (Azure Functions can run several instances concurrently, each
// with its own copy of this cache -- a sheet picked from one instance's
// fresher list can occasionally fail to resolve against another's slightly
// older one. resolveLinkedSheets's caller is expected to tell the requester
// when fewer sheets came back than were requested, rather than this cache
// trying to guarantee perfect cross-instance consistency for a 5-minute
// staleness window.)
async function listSheets() {
  if (!cache || cache.expiresAt <= Date.now()) {
    cache = { data: await fetchSheetsFromApi(), expiresAt: Date.now() + CACHE_MS };
  }
  return cache.data;
}

// Resolves client-submitted sheet ids against our own server-side sheet
// list -- the ONLY source of truth for a linked sheet's name/permalink (see
// the module comment on fetchSheetsFromApi: never trust client-supplied
// name/permalink text, since this is rendered as a link shown to the client
// too). An id that doesn't resolve (deleted, access revoked, or briefly
// stale across instances -- see listSheets above) is silently dropped from
// the return value; it's the caller's job to tell the requester if fewer
// sheets came back than were asked for. Caps at MAX_LINKED_SHEETS
// regardless of how many ids were requested.
async function resolveLinkedSheets(ids) {
  const requested = Array.isArray(ids) ? ids.slice(0, MAX_LINKED_SHEETS) : [];
  if (!requested.length) return [];
  const allSheets = await listSheets();
  const byId = new Map(allSheets.map((s) => [s.id, s]));
  return requested.map((id) => byId.get(String(id))).filter(Boolean);
}

function parseLinkedSheets(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

module.exports = { listSheets, resolveLinkedSheets, parseLinkedSheets, SmartsheetError, MAX_LINKED_SHEETS };
