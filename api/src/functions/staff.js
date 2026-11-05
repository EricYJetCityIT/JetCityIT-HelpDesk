const { app } = require('@azure/functions');
const { requireStaff, authErrorResponse } = require('../lib/auth');
const { getUsersByUpns } = require('../lib/graph');
const { getStaffUpns } = require('../lib/staffAccess');

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
      const upns = await getStaffUpns();
      const key = upns.join(',');
      if (!cache || cache.key !== key || cache.expiresAt <= Date.now()) {
        let data;
        try {
          data = await getUsersByUpns(upns);
        } catch (e) {
          context.log('STAFF_DIRECTORY_LOOKUP_FAILED ' + JSON.stringify({ error: e.message }));
          data = upns.map((upn) => ({ upn, name: null }));
        }
        cache = { key, data, expiresAt: Date.now() + CACHE_MS };
      }

      return { jsonBody: { staff: cache.data } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
