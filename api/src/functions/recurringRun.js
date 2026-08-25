const { app } = require('@azure/functions');
const { getClient, ensureTable, genTicketId, genMessageRowKey, recordActivity } = require('../lib/tables');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');
const { requireCronSecret, authErrorResponse } = require('../lib/auth');

const PARTITION = 'RECURRING';

function buildStaffTicketLink(ticketId) {
  return `https://helpdesk.jetcityit.com/staff.html?ticket=${encodeURIComponent(ticketId)}`;
}

// Each active recurring template due for its next run (never created yet,
// or intervalDays have passed since lastCreatedAt) gets a real ticket
// auto-created from it, assigned to the template's configured assignee if
// any (same assignment-notification email as a normal assignment).
// "Requester" on these tickets is the shared helpdesk mailbox itself --
// there's no real external client for internal recurring/maintenance
// work, so no client-facing confirmation email is sent and no client
// access token is generated for it. Invoked once a day by a GitHub
// Actions scheduled workflow (see .github/workflows/scheduled-ticks.yml)
// rather than an Azure Timer Trigger -- see the comment on
// requireCronSecret in lib/auth.js for why. The due-check above (interval
// since lastCreatedAt) is what actually gates ticket creation, so being
// invoked more often than once a day by that workflow (it runs every 5
// minutes and calls this same endpoint) is harmless, not a duplication risk.
app.http('recurringTicketsRun', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'internal/recurring-tickets-tick',
  handler: async (request, context) => {
    try {
      requireCronSecret(request);
      await ensureTable();
      const table = getClient();

      const due = [];
      for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } })) {
        if (!e.active) continue;
        const intervalMs = (Number(e.intervalDays) || 1) * 86400000;
        const last = e.lastCreatedAt ? new Date(e.lastCreatedAt).getTime() : 0;
        if (Date.now() - last >= intervalMs) due.push(e);
      }

      for (const tmpl of due) {
        const ticketId = genTicketId();
        const now = new Date().toISOString();
        try {
          await table.createEntity({
            partitionKey: ticketId,
            rowKey: '0',
            kind: 'meta',
            status: 'Open',
            priority: tmpl.priority || 'Normal',
            category: tmpl.category || 'Other',
            name: 'Recurring Task',
            email: SUPPORT_MAILBOX,
            company: '',
            subject: tmpl.subject,
            assignee: tmpl.assignee || '',
            createdAt: now,
            updatedAt: now,
          });
          await table.createEntity({
            partitionKey: ticketId,
            rowKey: genMessageRowKey(),
            kind: 'message',
            authorType: 'client',
            authorName: 'Recurring Task',
            authorUpn: '',
            body: tmpl.description,
            attachmentsJson: '',
            createdAt: now,
          });
          await recordActivity(table, ticketId, `Auto-created from recurring template "${tmpl.subject}"`);

          if (tmpl.assignee) {
            try {
              const html = `<p>A recurring ticket was just created and assigned to you:</p>
<p><strong>${escapeHtml(tmpl.subject)}</strong><br/>Ticket ${escapeHtml(ticketId)}</p>
<p><a href="${escapeHtml(buildStaffTicketLink(ticketId))}">Open in the staff console</a></p>`;
              await sendMail({ from: SUPPORT_MAILBOX, to: tmpl.assignee, subject: `Assigned: ${tmpl.subject} [${ticketId}]`, html });
            } catch (e2) {
              context.log('RECURRING_ASSIGN_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e2.message }));
            }
          }

          // The ticket above already exists at this point -- if THIS write
          // fails and never gets retried, the template stays "due" and the
          // next daily run creates a full duplicate ticket for the same
          // occurrence. A short retry-with-backoff covers the common case
          // (a transient Table Storage error); ticket creation and this
          // counter update can't be made truly atomic across two different
          // partitions without much more machinery than a once-a-day,
          // low-volume job justifies.
          let advanced = false;
          for (let attempt = 0; attempt < 3 && !advanced; attempt++) {
            try {
              await table.updateEntity({ partitionKey: PARTITION, rowKey: tmpl.rowKey, lastCreatedAt: now }, 'Merge');
              advanced = true;
            } catch (e4) {
              if (attempt === 2) {
                context.log('RECURRING_LASTCREATEDAT_UPDATE_FAILED ' + JSON.stringify({ templateId: tmpl.rowKey, ticketId, error: e4.message }));
              } else {
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
              }
            }
          }
        } catch (e3) {
          context.log('RECURRING_CREATE_FAILED ' + JSON.stringify({ templateId: tmpl.rowKey, error: e3.message }));
        }
      }

      if (due.length) context.log('RECURRING_TICKETS_CREATED ' + JSON.stringify({ count: due.length }));
      return { jsonBody: { ok: true, created: due.length } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
