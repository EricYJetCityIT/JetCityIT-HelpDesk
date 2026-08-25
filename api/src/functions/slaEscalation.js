const { app } = require('@azure/functions');
const { getClient, ensureTable, recordActivity } = require('../lib/tables');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');

// Wall-clock response-time targets by priority -- not business-hours-aware,
// kept deliberately simple for a small team. staff.html has its own copy of
// these same numbers (used there to color the ticket list's aging badge);
// keep both in sync if this policy changes.
const SLA_MINUTES = { High: 120, Normal: 480, Low: 1440 };

// Same helper as tickets.js/ticketsPublic.js -- kept as its own one-line
// copy rather than a shared export.
function buildStaffTicketLink(ticketId) {
  return `https://helpdesk.jetcityit.com/staff.html?ticket=${encodeURIComponent(ticketId)}`;
}

// Runs every 15 minutes. Scans open/unresolved tickets that have never had
// a staff reply (firstRespondedAt unset -- an internal note or a status
// change doesn't count) and are past their SLA target for their priority,
// and sends ONE escalation email per ticket: escalatedAt marks it sent so
// the same breach is never re-escalated on a later run. Notifies the
// assignee if the ticket has one, otherwise the shared helpdesk inbox --
// there's no manager-hierarchy concept at this team size, the goal is just
// making sure a human sees it, not routing to a specific escalation tier.
app.timer('slaEscalationCheck', {
  schedule: '0 */15 * * * *',
  handler: async (myTimer, context) => {
    try {
      await ensureTable();
      const table = getClient();

      const candidates = [];
      for await (const e of table.listEntities({
        queryOptions: { filter: "kind eq 'meta' and (status eq 'Open' or status eq 'Pending')" },
      })) {
        if (e.firstRespondedAt || e.escalatedAt) continue;
        const slaMin = SLA_MINUTES[e.priority] || SLA_MINUTES.Normal;
        const elapsedMin = (Date.now() - new Date(e.createdAt).getTime()) / 60000;
        if (elapsedMin >= slaMin) candidates.push(e);
      }

      for (const meta of candidates) {
        const ticketId = meta.partitionKey;
        const to = meta.assignee || SUPPORT_MAILBOX;
        try {
          const html = `<p>This ticket has passed its response-time target and hasn't had a staff reply yet:</p>
<p><strong>${escapeHtml(meta.subject)}</strong><br/>Ticket ${escapeHtml(ticketId)} · Priority: ${escapeHtml(meta.priority)}</p>
<p><a href="${escapeHtml(buildStaffTicketLink(ticketId))}">Open in the staff console</a></p>`;
          await sendMail({ from: SUPPORT_MAILBOX, to, subject: `SLA breach: ${meta.subject} [${ticketId}]`, html });
        } catch (e2) {
          context.log('SLA_ESCALATION_EMAIL_FAILED ' + JSON.stringify({ ticketId, error: e2.message }));
        }
        // Marked regardless of email success -- an escalation attempt that
        // failed to send shouldn't retry forever on every future tick; the
        // activity-trail entry below is the durable record either way.
        await table.updateEntity({ partitionKey: ticketId, rowKey: '0', escalatedAt: new Date().toISOString() }, 'Merge');
        await recordActivity(table, ticketId, `SLA response-time target missed -- escalation sent to ${to}`);
      }

      if (candidates.length) context.log('SLA_ESCALATIONS_SENT ' + JSON.stringify({ count: candidates.length }));
    } catch (e) {
      context.error(e);
    }
  },
});
