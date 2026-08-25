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
const { storeAttachments, deleteAttachments, downloadAttachment, parseAttachments, rejectIfTooLarge, AttachmentError } = require('../lib/attachments');
const { clientIp } = require('../lib/ip');

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
    category: e.category || 'Other',
    subject: e.subject,
    rating: e.rating || null,
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
    attachments: parseAttachments(m.attachmentsJson),
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
        // Internal staff notes (kind === 'note') are deliberately excluded --
        // this is the client-facing endpoint, and a note is only ever meant
        // for staff eyes. Anything other than 'meta'/'message' is dropped
        // rather than assumed safe to show, so a future new kind defaults to
        // hidden here instead of leaking by omission.
        else if (e.kind === 'message') messages.push(e);
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

      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;

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

      let attachments;
      try {
        attachments = await storeAttachments(ticketId, body.attachments);
      } catch (e) {
        if (e instanceof AttachmentError) throw new AuthError(400, e.message);
        throw e;
      }

      const now = new Date().toISOString();
      const messageRowKey = genMessageRowKey();
      try {
        await table.createEntity({
          partitionKey: ticketId,
          rowKey: messageRowKey,
          kind: 'message',
          authorType: 'client',
          authorName: meta.name,
          authorUpn: '',
          body: text,
          attachmentsJson: attachments.length ? JSON.stringify(attachments) : '',
          createdAt: now,
        });

        // A client following up means it needs another look regardless of
        // what it was parked at (Pending/Resolved/Closed) -- staff can
        // re-triage from Open rather than the reply going unnoticed in a
        // closed ticket.
        const update = { partitionKey: ticketId, rowKey: '0', updatedAt: now };
        if (meta.status !== 'Open') {
          update.status = 'Open';
          // A rating, a resolution time, a first-response time, and any
          // past SLA escalation all answer for a SPECIFIC episode of this
          // ticket -- once it reopens, none of them describe its current
          // state anymore. Clearing firstRespondedAt/escalatedAt here
          // matters in particular: without it, a ticket that was ever
          // responded to (or ever escalated) once would be permanently
          // invisible to slaEscalation.js's scan even after reopening and
          // sitting unanswered again.
          if (meta.rating) { update.rating = ''; update.ratedAt = ''; }
          if (meta.resolvedAt) update.resolvedAt = '';
          if (meta.firstRespondedAt) update.firstRespondedAt = '';
          if (meta.escalatedAt) update.escalatedAt = '';
        }
        await table.updateEntity(update, 'Merge');
      } catch (e) {
        await deleteAttachments(ticketId, attachments);
        // The message row above may have been created successfully even
        // though the following Merge failed (e.g. the ticket was deleted out
        // from under this request between the two calls) -- clean it up too,
        // not just the attachments, so a failed reply never leaves a message
        // behind. A no-op (safely swallowed) if createEntity itself is what
        // failed and the row was never written.
        await table.deleteEntity(ticketId, messageRowKey).catch(() => {});
        throw e;
      }

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

// A 1-tap satisfaction signal, only meaningful (and only shown in the UI)
// once a ticket is actually Resolved/Closed -- enforced server-side too,
// not just hidden in the UI, since this is reached via the same
// email+token auth as every other client route and could otherwise be
// called directly against a still-open ticket.
app.http('clientTicketRating', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'client/tickets/{ticketId}/rating',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('client-rating-ip:' + ip, 20, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const body = await request.json().catch(() => ({}));
      const email = String(body.email || '');
      const token = String(body.token || '');
      await verifyClientToken(email, token);

      const rating = String(body.rating || '');
      if (rating !== 'yes' && rating !== 'no') throw new AuthError(400, 'Invalid rating');

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
      if (meta.status !== 'Resolved' && meta.status !== 'Closed') {
        throw new AuthError(400, 'This ticket has not been resolved yet.');
      }

      // Overwrite, not append -- a client can change their mind, and only
      // the latest answer is meaningful.
      await table.updateEntity({ partitionKey: ticketId, rowKey: '0', rating, ratedAt: new Date().toISOString() }, 'Merge');
      audit(context, null, 'ticket.rate', { ticketId, rating });

      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('clientAttachmentGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'client/tickets/{ticketId}/attachments/{attachmentId}',
  handler: async (request, context) => {
    try {
      // Its own bucket, separate from clientTicketsList/clientTicketGet's
      // 'client-view-ip' -- a single ticket view can cost 1 (get) + up to 4
      // (attachments) requests, so sharing one budget let heavy attachment
      // viewing 429 an unrelated client behind the same office NAT/proxy IP
      // who was just trying to open their own ticket list.
      const ip = clientIp(request);
      const rl = checkRateLimit('client-attachment-ip:' + ip, 120, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const email = request.query.get('email') || '';
      const token = request.query.get('token') || '';
      await verifyClientToken(email, token);

      const { ticketId, attachmentId } = request.params;
      await ensureTable();
      const table = getClient();
      let meta;
      try {
        meta = await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Attachment not found' } };
        throw e;
      }
      // Same ownership re-check as clientTicketGet -- a valid token for one
      // address must never unlock another ticket's attachments.
      if (normalizeEmail(meta.email) !== normalizeEmail(email)) {
        return { status: 404, jsonBody: { error: 'Attachment not found' } };
      }

      const result = await downloadAttachment(ticketId, attachmentId);
      if (!result) return { status: 404, jsonBody: { error: 'Attachment not found' } };
      return {
        status: 200,
        headers: {
          'Content-Type': result.contentType,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `inline; filename="${attachmentId}"`,
        },
        body: result.buffer,
      };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
