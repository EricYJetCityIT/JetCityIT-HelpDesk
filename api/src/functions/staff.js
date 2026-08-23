const { app } = require('@azure/functions');
const { requireStaff, authErrorResponse, STAFF_UPNS } = require('../lib/auth');
const { getUsersByUpns } = require('../lib/graph');

const CACHE_MS = 30 * 60 * 1000; // staff names change rarely; avoid a Graph round-trip on every dropdown load
let cache = null; // { data, expiresAt }

// The assignee dropdown's data source: one row per STAFF_UPNS entry, with a
// display name resolved via Microsoft Graph where possible. Falls back to
// name:null (frontend just shows the raw email) rather than failing the
// whole list if Graph is unreachable, so a transient Graph issue never
// blocks staff from assigning tickets.
app.http('staffList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'staff',
  handler: async (request, context) => {
    try {
      await requireStaff(request);

      if (!cache || cache.expiresAt <= Date.now()) {
        let data;
        try {
          data = await getUsersByUpns(STAFF_UPNS);
        } catch (e) {
          context.log('STAFF_DIRECTORY_LOOKUP_FAILED ' + JSON.stringify({ error: e.message }));
          data = STAFF_UPNS.map((upn) => ({ upn, name: null }));
        }
        cache = { data, expiresAt: Date.now() + CACHE_MS };
      }

      return { jsonBody: { staff: cache.data } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
