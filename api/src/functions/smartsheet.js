const { app } = require('@azure/functions');
const { requireStaff, authErrorResponse } = require('../lib/auth');
const { listSheets, SmartsheetError } = require('../lib/smartsheet');

// Backing list for the reply box's "Link Smartsheet" picker.
app.http('smartsheetList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'smartsheet/sheets',
  handler: async (request, context) => {
    try {
      await requireStaff(request);
      const sheets = await listSheets();
      return { jsonBody: { sheets } };
    } catch (e) {
      if (e instanceof SmartsheetError) return { status: 502, jsonBody: { error: e.message } };
      return authErrorResponse(e, context);
    }
  },
});
