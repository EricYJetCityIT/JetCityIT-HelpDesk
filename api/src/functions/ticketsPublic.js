const { app } = require('@azure/functions');
const { getClient, ensureTable, genTicketId, genMessageRowKey } = require('../lib/tables');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');
const { getOrCreateClientToken, buildTrackingLink } = require('../lib/clientAccess');
const { storeAttachments, deleteAttachments, rejectIfTooLarge, AttachmentError } = require('../lib/attachments');
const { clientIp } = require('../lib/ip');

const MAX_LEN = { name: 120, email: 200, company: 150, subject: 200, description: 5000 };

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Public, unauthenticated ticket submission — the whole point is that anyone
// outside @jetcityit.com can reach it. Anti-abuse is IP rate limiting (tight:
// 5/min) plus a honeypot field; real authorization/scoping happens on the
// staff side, which is a completely separate, allowlisted set of endpoints.
app.http('ticketsCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tickets',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('submit:' + ip, 5, 60 * 1000);
      if (!rl.allowed) {
        return {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfterSec) },
          jsonBody: { error: 'Too many submissions — please slow down.' },
        };
      }

      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;

      const body = await request.json().catch(() => ({}));

      // Classic honeypot: a field hidden from real users via CSS that bots
      // fill in anyway. If populated, return a fake success without writing
      // anything, so the bot doesn't learn to look elsewhere.
      if (body.website) {
        return { status: 201, jsonBody: { ticketId: genTicketId() } };
      }

      const name = String(body.name || '').trim().slice(0, MAX_LEN.name);
      const email = String(body.email || '').trim().slice(0, MAX_LEN.email);
      const company = String(body.company || '').trim().slice(0, MAX_LEN.company);
      const subject = String(body.subject || '').trim().slice(0, MAX_LEN.subject);
      const description = String(body.description || '').trim().slice(0, MAX_LEN.description);

      if (!name || !isValidEmail(email) || !subject || !description) {
        return { status: 400, jsonBody: { error: 'Name, a valid email, subject, and description are required.' } };
      }

      await ensureTable();
      const table = getClient();
      const ticketId = genTicketId();
      const now = new Date().toISOString();

      let attachments;
      try {
        attachments = await storeAttachments(ticketId, body.attachments);
      } catch (e) {
        if (e instanceof AttachmentError) return { status: 400, jsonBody: { error: e.message } };
        throw e;
      }

      try {
        await table.createEntity({
          partitionKey: ticketId,
          rowKey: '0',
          kind: 'meta',
          status: 'Open',
          priority: 'Normal',
          name,
          email,
          company,
          subject,
          assignee: '',
          createdAt: now,
          updatedAt: now,
        });

        await table.createEntity({
          partitionKey: ticketId,
          rowKey: genMessageRowKey(),
          kind: 'message',
          authorType: 'client',
          authorName: name,
          authorUpn: '',
          body: description,
          attachmentsJson: attachments.length ? JSON.stringify(attachments) : '',
          createdAt: now,
        });
      } catch (e) {
        // The attachments already uploaded successfully -- if the ticket
        // itself then fails to persist, don't leave those blobs behind
        // referencing a ticket that will never exist.
        await deleteAttachments(ticketId, attachments);
        throw e;
      }

      audit(context, null, 'ticket.create', { ticketId, ip });

      try {
        const clientToken = await getOrCreateClientToken(email);
        const link = buildTrackingLink(email, clientToken, ticketId);
        const html = `<p>Hi ${escapeHtml(name)},</p>
<p>We've received your ticket and a technician will follow up soon.</p>
<p><strong>Subject:</strong> ${escapeHtml(subject)}<br/><strong>Ticket:</strong> ${escapeHtml(ticketId)}</p>
<p><a href="${escapeHtml(link)}">Track this ticket and view your ticket history</a></p>
<p>— Jet City IT Help Desk</p>`;
        await sendMail({ from: SUPPORT_MAILBOX, to: email, subject: `We've received your ticket [${ticketId}]`, html });
      } catch (e) {
        context.log('EMAIL_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
      }

      return { status: 201, jsonBody: { ticketId } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
  },
});
