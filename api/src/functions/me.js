const { app } = require('@azure/functions');
const { requireStaff, authErrorResponse } = require('../lib/auth');

// Lets the frontend distinguish "not signed in" (401 — prompt sign-in) from
// "signed in but not on the staff list" (200, isStaff:false — show a plain
// access-denied message instead of retrying sign-in in a loop).
app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      return { jsonBody: { upn: user.upn, name: user.name, isStaff: true } };
    } catch (e) {
      if (e.status === 403) return { jsonBody: { isStaff: false } };
      return authErrorResponse(e, context);
    }
  },
});
