const { app } = require('@azure/functions');
const { getClient, ensureTable, recordActivity } = require('../lib/tables');
const { audit } = require('../lib/audit');
const { requireCronSecret, authErrorResponse } = require('../lib/auth');
const { withTickLease } = require('../lib/tickLease');

// How long a ticket sits in Resolved before it's closed automatically.
const AUTO_CLOSE_DAYS = 3;
// Upper bound per run. The first run after deploy closes every historical
// Resolved ticket older than AUTO_CLOSE_DAYS at once, and this loop is
// serial with a few round trips per ticket -- an unbounded backlog could
// outlast the platform's 45-second API request limit mid-loop. The rest
// simply close on the next tick (about 5 minutes later).
const MAX_PER_TICK = 30;

// Closes tickets that have been Resolved for AUTO_CLOSE_DAYS. A client who
// replies to a Resolved ticket reopens it (clientTicketReply / orgTicketReply
// / emailIngest all set status back to Open), so a ticket still sitting in
// Resolved hasn't had a client REPLY since it was resolved. The one client
// signal that doesn't reopen -- a 👎 rating -- is handled explicitly below.
//
// Deliberately silent: no email to the client (they were already told it was
// resolved), no team broadcast. The activity-trail entry is the visible
// record. Resolved -> Closed is not a reopen, so rating/resolvedAt are left
// alone, same as a manual close. Called on a schedule (an Azure Logic App
// every ~5 minutes, see infra/README.md; the GitHub workflow is only a slow
// backstop), not an Azure Timer Trigger -- see requireCronSecret in
// lib/auth.js for why.
app.http('autoCloseCheck', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'internal/auto-close-tick',
  handler: async (request, context) => {
    try {
      requireCronSecret(request);
      // One run at a time per job, and a heartbeat the staff console shows (lib/tickLease.js).
      const run = await withTickLease('auto-close', context, async () => {
        await ensureTable();
        const table = getClient();
        const cutoff = Date.now() - AUTO_CLOSE_DAYS * 86400000;

        const candidates = [];
        for await (const e of table.listEntities({
          queryOptions: { filter: "kind eq 'meta' and status eq 'Resolved'" },
        })) {
          // A 👎 from the client means they're unhappy with the resolution --
          // closing it would drop it out of the staff console's default "All"
          // view (which hides Closed) and bury exactly the ticket someone
          // should still look at. Left Resolved until staff deal with it.
          if (e.rating === 'no') continue;
          // The later of resolvedAt and updatedAt, not resolvedAt alone:
          // resolvedAt is only set the FIRST time a ticket reaches a terminal
          // state, so a ticket staff moved back from Closed to Resolved keeps
          // its old resolvedAt and would be re-closed on the very next tick.
          // updatedAt is bumped by any staff edit or reply, so the 3 days
          // restart whenever staff touch a Resolved ticket. It also covers old
          // tickets resolved before resolvedAt was tracked. Both missing or
          // unparseable -> 0 -> skipped rather than closed on no evidence.
          const since = Math.max(Date.parse(e.resolvedAt) || 0, Date.parse(e.updatedAt) || 0);
          if (since && since <= cutoff) candidates.push(e);
        }

        const batch = candidates.slice(0, MAX_PER_TICK);
        if (candidates.length > batch.length) {
          context.log('AUTO_CLOSE_BACKLOG ' + JSON.stringify({ closingNow: batch.length, remaining: candidates.length - batch.length }));
        }

        let closed = 0;
        let failed = 0; // reported to the heartbeat (lib/tickLease.js), not swallowed into an "OK"
        let warnedNoEtag = false;
        for (const meta of batch) {
          const ticketId = meta.partitionKey;
          // If the SDK ever stops returning etag on listed entities, the write
          // below silently becomes unconditional (the reopen-race guard is
          // lost but closing still works) -- leave one visible trace of that.
          if (!meta.etag && !warnedNoEtag) {
            warnedNoEtag = true;
            context.log('AUTO_CLOSE_NO_ETAG listed entity had no etag; closing without the race guard');
          }
          try {
            // Conditional on the row being unchanged since the scan above, so a
            // client reply that reopens the ticket in between isn't overwritten
            // back to Closed (a 412 here means exactly that -- leave it alone).
            await table.updateEntity(
              { partitionKey: ticketId, rowKey: '0', status: 'Closed', updatedAt: new Date().toISOString() },
              'Merge',
              { etag: meta.etag }
            );
          } catch (e) {
            // 412: the row changed since the scan (e.g. reopened). 404: staff
            // deleted the ticket mid-run. Both mean "nothing to close" -- only
            // anything else is a real failure worth a log line.
            if (e.statusCode !== 412 && e.statusCode !== 404) {
              failed++;
              context.log('AUTO_CLOSE_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
            }
            continue;
          }
          closed++;
          await recordActivity(table, ticketId, `Auto-closed after ${AUTO_CLOSE_DAYS} days in Resolved`);
          audit(context, null, 'ticket.autoClose', { ticketId });
        }

        if (closed) context.log('AUTO_CLOSED ' + JSON.stringify({ count: closed }));
        return { ok: true, closed, problems: failed, problem: failed ? failed + ' ticket(s) could not be closed (see logs)' : '' };
      });
      if (run.skipped) return { jsonBody: { ok: true, skipped: true } };
      return { jsonBody: run.result };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
