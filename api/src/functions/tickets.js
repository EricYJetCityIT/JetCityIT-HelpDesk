const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse } = require('../lib/auth');
const { getClient, ensureTable, genMessageRowKey } = require('../lib/tables');
const { audit } = require('../lib/audit');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');
const { getOrCreateClientToken, buildTrackingLink } = require('../lib/clientAccess');
const { storeAttachments, deleteAttachments, downloadAttachment, parseAttachments, rejectIfTooLarge, AttachmentError } = require('../lib/attachments');

const STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Normal', 'High'];

// OData string literals escape an embedded single quote by doubling it.
// ticketId/status here are either server-generated or whitelist-checked, but
// this is cheap defense-in-depth against filter injection regardless.
function odataEscape(s) {
  return String(s).replace(/'/g, "''");
}

function metaToJson(e) {
  return {
    ticketId: e.partitionKey,
    status: e.status,
    priority: e.priority,
    name: e.name,
    email: e.email,
    company: e.company,
    subject: e.subject,
    assignee: e.assignee || '',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function messageToJson(e) {
  return {
    authorType: e.authorType,
    authorName: e.authorName,
    authorUpn: e.authorUpn || '',
    body: e.body,
    attachments: parseAttachments(e.attachmentsJson),
    createdAt: e.createdAt,
  };
}

// List all tickets (meta rows only), newest-updated first. Optional
// ?status=Open filter. Table Storage has no secondary index here, so this is
// a full-table scan filtered server-side — fine at help-desk volume; revisit
// (e.g. a status-partitioned view) if ticket count grows into the thousands.
app.http('ticketsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tickets',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      await ensureTable();
      const table = getClient();

      const status = request.query.get('status');
      let filter = "kind eq 'meta'";
      if (status && STATUSES.includes(status)) {
        filter += ` and status eq '${odataEscape(status)}'`;
      }

      const tickets = [];
      for await (const e of table.listEntities({ queryOptions: { filter } })) {
        tickets.push(metaToJson(e));
      }
      tickets.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

      audit(context, user, 'ticket.list', { count: tickets.length, status: status || null });
      return { jsonBody: { tickets } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// One ticket's metadata plus its full message thread, chronological.
app.http('ticketGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { ticketId } = request.params;
      await ensureTable();
      const table = getClient();

      let meta = null;
      const messages = [];
      for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${odataEscape(ticketId)}'` } })) {
        if (e.kind === 'meta') meta = e;
        else messages.push(e);
      }
      if (!meta) return { status: 404, jsonBody: { error: 'Ticket not found' } };

      messages.sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1));
      audit(context, user, 'ticket.get', { ticketId });
      return { jsonBody: { ...metaToJson(meta), messages: messages.map(messageToJson) } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Partial update of a ticket's status / priority / assignee.
app.http('ticketUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { ticketId } = request.params;
      const body = await request.json().catch(() => ({}));
      await ensureTable();
      const table = getClient();

      const update = { partitionKey: ticketId, rowKey: '0', updatedAt: new Date().toISOString() };

      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw new AuthError(400, 'Invalid status');
        update.status = body.status;
      }
      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) throw new AuthError(400, 'Invalid priority');
        update.priority = body.priority;
      }
      if (body.assignee !== undefined) {
        update.assignee = String(body.assignee || '').trim();
      }

      try {
        await table.updateEntity(update, 'Merge');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }

      audit(context, user, 'ticket.update', { ticketId, fields: Object.keys(body) });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Append a staff reply to a ticket's thread.
app.http('ticketReply', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}/replies',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { ticketId } = request.params;

      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;

      const body = await request.json().catch(() => ({}));
      const text = String(body.body || '').trim().slice(0, 5000);
      if (!text) throw new AuthError(400, 'Reply body is required');

      await ensureTable();
      const table = getClient();
      const now = new Date().toISOString();

      // Confirmed to exist BEFORE storing attachments (matching the client
      // reply endpoint's ordering) -- otherwise a typo'd/made-up ticketId
      // would still upload real blobs and write a message row into a
      // partition that will never have a meta row to surface them from.
      let meta;
      try {
        meta = await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }

      let attachments;
      try {
        attachments = await storeAttachments(ticketId, body.attachments);
      } catch (e) {
        if (e instanceof AttachmentError) throw new AuthError(400, e.message);
        throw e;
      }

      try {
        await table.createEntity({
          partitionKey: ticketId,
          rowKey: genMessageRowKey(),
          kind: 'message',
          authorType: 'staff',
          authorName: user.name,
          authorUpn: user.upn,
          body: text,
          attachmentsJson: attachments.length ? JSON.stringify(attachments) : '',
          createdAt: now,
        });
        await table.updateEntity({ partitionKey: ticketId, rowKey: '0', updatedAt: now }, 'Merge');
      } catch (e) {
        await deleteAttachments(ticketId, attachments);
        throw e;
      }

      audit(context, user, 'ticket.reply', { ticketId });

      if (meta.email) {
        try {
          const clientToken = await getOrCreateClientToken(meta.email);
          const link = buildTrackingLink(meta.email, clientToken, ticketId);
          const html = `<p>Hi ${escapeHtml(meta.name)},</p>
<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>
<p><a href="${escapeHtml(link)}">View this ticket and reply online</a></p>
<p>— Jet City IT Help Desk<br/>Ticket ${escapeHtml(ticketId)}</p>`;
          await sendMail({ from: SUPPORT_MAILBOX, to: meta.email, subject: `Re: ${meta.subject} [${ticketId}]`, html });
        } catch (e) {
          context.log('EMAIL_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
        }
      }

      return { status: 201, jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Streams one attachment's bytes back. Staff have no per-ticket read
// restriction (same "no read tier" model as the rest of this file), so the
// only check needed here is requireStaff itself.
app.http('ticketAttachmentGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}/attachments/{attachmentId}',
  handler: async (request, context) => {
    try {
      await requireStaff(request);
      const { ticketId, attachmentId } = request.params;
      const result = await downloadAttachment(ticketId, attachmentId);
      if (!result) return { status: 404, jsonBody: { error: 'Attachment not found' } };
      return {
        status: 200,
        headers: {
          'Content-Type': result.contentType,
          'Cache-Control': 'private, max-age=3600',
          // Defense in depth: content type is already always a real image/*
          // (never attacker-declared, see attachments.js), so this can't
          // currently be promoted to text/html by sniffing -- but neither
          // Azure's global security headers nor CSP reach API responses,
          // so this route sets its own rather than relying on either.
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
