const { app } = require('@azure/functions');
const { getClient, ensureTable, genMessageRowKey } = require('../lib/tables');
const { checkRateLimit } = require('../lib/ratelimit');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');
const { AuthError, authErrorResponse } = require('../lib/auth');
const {
  normalizeEmail,
  getOrCreateClientToken,
  verifyClientToken,
  findTicketsByEmail,
  buildTrackingLink,
} = require('../lib/clientAccess');
const { audit } = require('../lib/audit');

function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || 'unknown';
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function odataEscape(s) {
  return String(s).replace(/'/g, "''");
}

function ticketToClientJson(e) {
  return {
    ticketId: e.partitionKey,
    status: e.status,
    priority: e.priority,
    subject: e.subject,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

// Staff messages are attributed to the help desk as a whole, not the
// individual technician -- clients never see internal names/UPNs here.
function messageToClientJson(m) {
  return {
    from: m.authorType === 'staff' ? 'staff' : 'you',
    body: m.body,
    createdAt: m.createdAt,
  };
}

// Request a tracking link by email. Rate-limited per IP AND per target
// email (so this endpoint can't be used to spam a stranger's inbox), and
// ALWAYS returns the same generic response whether or not that email has
// any tickets -- the only way to learn the answer is to check that inbox,
// which is the point.
app.http('clientRequestAccess', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'client/access',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const ipLimit = checkRateLimit('client-access-ip:' + ip, 10, 60 * 1000);
      if (!ipLimit.allowed) {
        return { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) }, jsonBody: { ok: true } };
      }

      const body = await request.json().catch(() => ({}));
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) {
        return { status: 400, jsonBody: { error: 'A valid email is required.' } };
      }

      const emailLimit = checkRateLimit('client-access-email:' + email, 3, 15 * 60 * 1000);
      if (emailLimit.allowed) {
        const tickets = await findTicketsByEmail(email);
        if (tickets.length) {
          const token = await getOrCreateClientToken(email);
          const link = buildTrackingLink(email, token);
          const html = `<p>Here's your link to track your Jet City IT Help Desk tickets:</p>
<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
<p>This shows every ticket submitted with this email address, and lets you
reply to any of them. Keep the link handy -- anyone who has it can view and
reply to these tickets, so don't forward it.</p>
<p>— Jet City IT Help Desk</p>`;
          try {
            await sendMail({ from: SUPPORT_MAILBOX, to: email, subject: 'Your Jet City IT Help Desk tracking link', html });
          } catch (e) {
            context.log('CLIENT_ACCESS_EMAIL_FAILED ' + JSON.stringify({ email, error: e.message }));
          }
        }
      }
      // Same response either way (rate-limited, no tickets found, or sent).
      return { jsonBody: { ok: true } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
  },
});

app.http('clientTicketsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'client/tickets',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('client-view-ip:' + ip, 60, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const email = request.query.get('email') || '';
      const token = request.query.get('token') || '';
      await verifyClientToken(email, token);

      const tickets = (await findTicketsByEmail(email))
        .map(ticketToClientJson)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

      return { jsonBody: { tickets } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('clientTicketGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'client/tickets/{ticketId}',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('client-view-ip:' + ip, 60, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const email = request.query.get('email') || '';
      const token = request.query.get('token') || '';
      await verifyClientToken(email, token);

      const { ticketId } = request.params;
      await ensureTable();
      const table = getClient();

      let meta = null;
      const messages = [];
      for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${odataEscape(ticketId)}'` } })) {
        if (e.kind === 'meta') meta = e;
        else messages.push(e);
      }
      // Owning email must match -- a valid token for one address must never
      // unlock a ticket filed under a different one, even by guessed ID.
      if (!meta || normalizeEmail(meta.email) !== normalizeEmail(email)) {
        return { status: 404, jsonBody: { error: 'Ticket not found' } };
      }

      messages.sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1));
      return { jsonBody: { ...ticketToClientJson(meta), messages: messages.map(messageToClientJson) } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('clientTicketReply', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'client/tickets/{ticketId}/replies',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('client-reply-ip:' + ip, 10, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const body = await request.json().catch(() => ({}));
      const email = String(body.email || '');
      const token = String(body.token || '');
      await verifyClientToken(email, token);

      const text = String(body.body || '').trim().slice(0, 5000);
      if (!text) throw new AuthError(400, 'Reply body is required');

      const { ticketId } = request.params;
      await ensureTable();
      const table = getClient();

      let meta;
      try {
        meta = await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }
      if (normalizeEmail(meta.email) !== normalizeEmail(email)) {
        return { status: 404, jsonBody: { error: 'Ticket not found' } };
      }

      const now = new Date().toISOString();
      await table.createEntity({
        partitionKey: ticketId,
        rowKey: genMessageRowKey(),
        kind: 'message',
        authorType: 'client',
        authorName: meta.name,
        authorUpn: '',
        body: text,
        createdAt: now,
      });

      // A client following up means it needs another look regardless of what
      // it was parked at (Pending/Resolved/Closed) -- staff can re-triage
      // from Open rather than the reply going unnoticed in a closed ticket.
      const update = { partitionKey: ticketId, rowKey: '0', updatedAt: now };
      if (meta.status !== 'Open') update.status = 'Open';
      await table.updateEntity(update, 'Merge');

      audit(context, null, 'ticket.clientReply', { ticketId });

      try {
        const html = `<p>Client reply on ticket ${escapeHtml(ticketId)} (${escapeHtml(meta.subject)}):</p>
<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>
<p><a href="https://helpdesk.jetcityit.com/staff.html">Open in staff console</a></p>`;
        await sendMail({ from: SUPPORT_MAILBOX, to: SUPPORT_MAILBOX, subject: `Client replied: ${meta.subject} [${ticketId}]`, html });
      } catch (e) {
        context.log('STAFF_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
      }

      return { status: 201, jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
