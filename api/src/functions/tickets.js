const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse, STAFF_UPNS } = require('../lib/auth');
const { getClient, ensureTable, genMessageRowKey } = require('../lib/tables');
const { audit } = require('../lib/audit');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');
const { getOrCreateClientToken, buildTrackingLink } = require('../lib/clientAccess');
const { storeAttachments, deleteAttachments, deleteAllAttachmentsForTicket, downloadAttachment, parseAttachments, rejectIfTooLarge, AttachmentError } = require('../lib/attachments');

const STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Normal', 'High'];

// OData string literals escape an embedded single quote by doubling it.
// ticketId/status here are either server-generated or whitelist-checked, but
// this is cheap defense-in-depth against filter injection regardless.
function odataEscape(s) {
  return String(s).replace(/'/g, "''");
}

// staff.html reads ?ticket= on load and opens that ticket directly instead
// of the list -- used so an assignment-notification email can link straight
// to the relevant ticket rather than just the console's front page.
function buildStaffTicketLink(ticketId) {
  return `https://helpdesk.jetcityit.com/staff.html?ticket=${encodeURIComponent(ticketId)}`;
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
    kind: e.kind, // 'message' or 'note' -- staff-only endpoint, so notes are included and the frontend distinguishes them
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

      // Fetched up front (not just relied on updateEntity's 404) so the
      // previous assignee and subject are available for the "changed to a
      // new person" check and notification email below.
      let meta;
      try {
        meta = await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }

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
        const assignee = String(body.assignee || '').trim().toLowerCase();
        // The dropdown only ever offers STAFF_UPNS entries (or blank for
        // unassigned) -- this rejects anything else rather than silently
        // storing it, since assignee is also used as an email address below.
        if (assignee && !STAFF_UPNS.includes(assignee)) throw new AuthError(400, 'Invalid assignee');
        update.assignee = assignee;
      }

      await table.updateEntity(update, 'Merge');

      audit(context, user, 'ticket.update', { ticketId, fields: Object.keys(body) });

      const previousAssignee = String(meta.assignee || '').trim().toLowerCase();
      if (update.assignee && update.assignee !== previousAssignee) {
        try {
          const html = `<p>You've been assigned a ticket:</p>
<p><strong>${escapeHtml(meta.subject)}</strong><br/>Ticket ${escapeHtml(ticketId)}</p>
<p><a href="${escapeHtml(buildStaffTicketLink(ticketId))}">Open in the staff console</a></p>`;
          await sendMail({ from: SUPPORT_MAILBOX, to: update.assignee, subject: `Assigned: ${meta.subject} [${ticketId}]`, html });
        } catch (e) {
          context.log('ASSIGN_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
        }
      }

      // A bare status change (no reply text) previously notified nobody --
      // only a reply's own email happened to carry the news. Client only,
      // since a status change made via a client's own reply goes through a
      // different code path (clientTicketReply) that doesn't hit this route.
      if (update.status && update.status !== meta.status && meta.email) {
        try {
          const clientToken = await getOrCreateClientToken(meta.email);
          const link = buildTrackingLink(meta.email, clientToken, ticketId);
          const html = `<p>Hi ${escapeHtml(meta.name)},</p>
<p>Your ticket status was updated to <strong>${escapeHtml(update.status)}</strong>.</p>
<p><a href="${escapeHtml(link)}">View this ticket online</a></p>
<p>— Jet City IT Help Desk<br/>Ticket ${escapeHtml(ticketId)}</p>`;
          await sendMail({ from: SUPPORT_MAILBOX, to: meta.email, subject: `Status updated: ${meta.subject} [${ticketId}]`, html });
        } catch (e) {
          context.log('STATUS_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
        }
      }

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

      const messageRowKey = genMessageRowKey();
      try {
        await table.createEntity({
          partitionKey: ticketId,
          rowKey: messageRowKey,
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
        // The message row above may have been created successfully even
        // though the following Merge failed (e.g. the ticket was deleted out
        // from under this request between the two calls) -- clean it up too,
        // not just the attachments, so a failed reply never leaves a message
        // behind. A no-op (safely swallowed) if createEntity itself is what
        // failed and the row was never written.
        await table.deleteEntity(ticketId, messageRowKey).catch(() => {});
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

// Adds a staff-only internal note to a ticket's thread. Deliberately separate
// from ticketReply: no client email, no client-facing visibility at all (see
// clientPortal.js's clientTicketGet, which explicitly drops kind !== 'message'
// rows), and doesn't touch updatedAt -- jotting a note for the team shouldn't
// make a ticket look "recently worked" to a client-facing status check or
// reset its aging indicator in the console.
app.http('ticketNoteAdd', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}/notes',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { ticketId } = request.params;
      const body = await request.json().catch(() => ({}));
      const text = String(body.body || '').trim().slice(0, 5000);
      if (!text) throw new AuthError(400, 'Note body is required');

      await ensureTable();
      const table = getClient();

      try {
        await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }

      await table.createEntity({
        partitionKey: ticketId,
        rowKey: genMessageRowKey(),
        kind: 'note',
        authorType: 'staff',
        authorName: user.name,
        authorUpn: user.upn,
        body: text,
        attachmentsJson: '',
        createdAt: new Date().toISOString(),
      });

      audit(context, user, 'ticket.note', { ticketId });
      return { status: 201, jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Permanently deletes a ticket: every row in its Table Storage partition
// (the meta row plus the full message thread) and every attachment blob
// filed under it. There is no undo and no soft-delete/trash -- this is a
// deliberate, staff-initiated destructive action, not something reachable
// from a status change.
app.http('ticketDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { ticketId } = request.params;
      await ensureTable();
      const table = getClient();

      // Require a real ticket (a meta row at RowKey '0') before deleting
      // anything. Without this, a crafted ticketId matching a *different*
      // reserved partition name in this same table -- e.g. "CLIENT", where
      // clientAccess.js stores every client's per-email access token --
      // would pass straight through to the blanket row-deletion below and
      // wipe it, since any non-empty PartitionKey scan used to satisfy the
      // old "does this partition have rows" check.
      try {
        await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }

      const rowKeys = [];
      for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${odataEscape(ticketId)}'` } })) {
        rowKeys.push(e.rowKey);
      }

      // allSettled (not all) so one row failing never aborts the rest of the
      // batch mid-flight -- every row still gets its own delete attempt. A
      // 404 on an individual row (e.g. a second staff member deleting the
      // same ticket at nearly the same time) is treated as already-done
      // rather than a real failure, so a losing race no longer surfaces a
      // confusing 500 for a delete that in fact succeeded.
      const results = await Promise.allSettled(rowKeys.map((rowKey) => table.deleteEntity(ticketId, rowKey)));
      // Best-effort and unconditional -- runs even if a row above genuinely
      // failed, so a partial row failure can never also skip attachment
      // cleanup or the audit log entry the way an early-abort would.
      await deleteAllAttachmentsForTicket(ticketId);
      const realFailure = results.find((r) => r.status === 'rejected' && r.reason && r.reason.statusCode !== 404);

      audit(context, user, 'ticket.delete', { ticketId, rowCount: rowKeys.length, partial: !!realFailure });
      if (realFailure) throw realFailure.reason;

      return { jsonBody: { ok: true } };
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
