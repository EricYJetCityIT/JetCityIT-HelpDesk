const { app } = require('@azure/functions');
const { requireStaff, authErrorResponse, AZURE_STAFF_UPNS } = require('../lib/auth');
const { getUsersByUpns } = require('../lib/graph');
const { getPageStaff } = require('../lib/staffAccess');

const CACHE_MS = 30 * 60 * 1000; // staff names change rarely; avoid a Graph round-trip on every dropdown load
let cache = null; // { key, data, expiresAt }

// The assignee dropdown's data source: one row per staff member (the Azure
// STAFF_UPNS list plus anyone added on the Access tab), with a display name
// resolved via Microsoft Graph where possible. Falls back to name:null
// (frontend just shows the raw email) rather than failing the whole list if
// Graph is unreachable, so a transient Graph issue never blocks staff from
// assigning tickets.
app.http('staffList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staff',
  handler: async (request, context) => {
    try {
      await requireStaff(request);

      // The cache is keyed by WHO is on the list, not just by time, so someone
      // added or removed on the Access tab shows up in the dropdown right away
      // instead of after the 30-minute name cache expires.
      const { people } = await getPageStaff();
      const key = AZURE_STAFF_UPNS.concat(people.map((p) => p.upn)).join(',');
      if (!cache || cache.key !== key || cache.expiresAt <= Date.now()) {
        // Only the few Azure-listed people need a Graph lookup: anyone added on the Access tab carries
        // the name they were added with, so a longer list never means more Graph calls.
        let azure;
        try {
          azure = await getUsersByUpns(AZURE_STAFF_UPNS);
        } catch (e) {
          context.log('STAFF_DIRECTORY_LOOKUP_FAILED ' + JSON.stringify({ error: e.message }));
          azure = AZURE_STAFF_UPNS.map((upn) => ({ upn, name: null }));
        }
        const seen = new Set(azure.map((s) => s.upn));
        const data = azure.concat(people.filter((p) => !seen.has(p.upn)).map((p) => ({ upn: p.upn, name: p.name })));
        cache = { key, data, expiresAt: Date.now() + CACHE_MS };
      }

      return { jsonBody: { staff: cache.data } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
