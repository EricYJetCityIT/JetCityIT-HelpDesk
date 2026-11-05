const { app } = require('@azure/functions');
const { requireStaff, authErrorResponse } = require('../lib/auth');
const { readJobStatus } = require('../lib/tickLease');

// The staff console's "background jobs" indicator: when each scheduled job (email replies, SLA
// escalation, recurring tickets, auto-close) last ran and whether it worked. The scheduler that calls
// them lives outside this app, and for months the one in use ran them only every few hours without
// anything saying so; this is what makes that visible. Any staff member can read it; it carries no
// ticket data, just job names and times.
//   GET /api/jobs-status -> { now, jobs:[{ job, label, lastStartedAt, lastFinishedAt, lastResult,
//                                           lastError, running, unknown }] }
app.http('jobsStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'jobs-status',
  handler: async (request, context) => {
    try {
      await requireStaff(request);
      return { jsonBody: { now: new Date().toISOString(), jobs: await readJobStatus() } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
