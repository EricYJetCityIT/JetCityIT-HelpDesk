const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse, STAFF_UPNS } = require('../lib/auth');
const { getClient, ensureTable, genMessageRowKey, genMessageRowKeyAt, TICKET_CATEGORIES, recordActivity } = require('../lib/tables');
const { audit } = require('../lib/audit');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');
const { getOrCreateClientToken, buildTrackingLink } = require('../lib/clientAccess');
const { storeAttachments, deleteAttachments, deleteAllAttachmentsForTicket, downloadAttachment, copyAttachmentToTicket, parseAttachments, rejectIfTooLarge, dispositionFor, AttachmentError } = require('../lib/attachments');

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
    category: e.category || 'Other',
    name: e.name,
    email: e.email,
    company: e.company,
    subject: e.subject,
    assignee: e.assignee || '',
    rating: e.rating || null,
    ratedAt: e.ratedAt || null,
    totalTimeMinutes: e.totalTimeMinutes || 0,
    firstRespondedAt: e.firstRespondedAt || null,
    escalatedAt: e.escalatedAt || null,
    resolvedAt: e.resolvedAt || null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function messageToJson(e) {
  return {
    kind: e.kind, // 'message', 'note', 'activity', or 'time' -- staff-only endpoint, frontend renders each differently
    authorType: e.authorType,
    authorName: e.authorName,
    authorUpn: e.authorUpn || '',
    body: e.body,
    minutes: e.minutes, // only present on kind: 'time' rows
    note: e.note, // only present on kind: 'time' rows
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

      const previousAssignee = String(meta.assignee || '').trim().toLowerCase();
      const update = { partitionKey: ticketId, rowKey: '0', updatedAt: new Date().toISOString() };

      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw new AuthError(400, 'Invalid status');
        update.status = body.status;
        const isTerminal = update.status === 'Resolved' || update.status === 'Closed';
        const wasTerminal = meta.status === 'Resolved' || meta.status === 'Closed';
        if (!isTerminal) {
          // Same reasoning throughout this block: a rating, a resolution
          // time, a first-response time, and any past SLA escalation all
          // answer for a SPECIFIC open/unresolved episode of this ticket,
          // so moving it back to Open/Pending invalidates them -- without
          // clearing firstRespondedAt/escalatedAt here, a ticket that was
          // ever responded to (or ever escalated) once would be
          // permanently invisible to slaEscalation.js's scan even after
          // reopening and sitting unanswered again. Resolved<->Closed is
          // not a reopen -- that's just closing the books on the same
          // resolution -- so none of this is touched by that transition.
          if (meta.rating) { update.rating = ''; update.ratedAt = ''; }
          if (meta.resolvedAt) update.resolvedAt = '';
          if (meta.firstRespondedAt) update.firstRespondedAt = '';
          if (meta.escalatedAt) update.escalatedAt = '';
        } else if (!wasTerminal) {
          // First time reaching a terminal state for this resolution
          // attempt -- this is what resolution-time reporting measures.
          update.resolvedAt = update.updatedAt;
        }
      }
      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) throw new AuthError(400, 'Invalid priority');
        update.priority = body.priority;
      }
      if (body.category !== undefined) {
        if (!TICKET_CATEGORIES.includes(body.category)) throw new AuthError(400, 'Invalid category');
        update.category = body.category;
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

      // Only fields that actually CHANGED, not every field the client sent
      // -- the console's "Save changes" button always sends status +
      // priority + category + assignee together, so logging every present
      // field would spam the trail with no-op entries on every save.
      const changes = [];
      if (update.status !== undefined && update.status !== meta.status) changes.push(`status → ${update.status}`);
      if (update.priority !== undefined && update.priority !== meta.priority) changes.push(`priority → ${update.priority}`);
      if (update.category !== undefined && update.category !== (meta.category || 'Other')) changes.push(`category → ${update.category}`);
      if (update.assignee !== undefined && update.assignee !== previousAssignee) {
        changes.push(`assignee → ${update.assignee || 'Unassigned'}`);
      }
      if (changes.length) {
        await recordActivity(table, ticketId, `${user.name || user.upn} updated ${changes.join(', ')}`);
      }

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
        // First STAFF reply only -- this is the SLA "first response" clock,
        // and only a real client-visible reply should stop it (an internal
        // note or a status change doesn't count as responding).
        const metaUpdate = { partitionKey: ticketId, rowKey: '0', updatedAt: now };
        if (!meta.firstRespondedAt) metaUpdate.firstRespondedAt = now;
        await table.updateEntity(metaUpdate, 'Merge');
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

// Logs a chunk of time spent on a ticket. Stored both as its own thread row
// (kind: 'time', for the visible per-entry log) and denormalized onto the
// meta row's totalTimeMinutes (so the ticket list / CSV export can show a
// running total without fetching every ticket's full message thread).
app.http('ticketTimeAdd', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}/time',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { ticketId } = request.params;
      const body = await request.json().catch(() => ({}));

      const minutes = Math.round(Number(body.minutes));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        throw new AuthError(400, 'Minutes must be a whole number between 1 and 1440.');
      }
      const note = String(body.note || '').trim().slice(0, 500);

      await ensureTable();
      const table = getClient();

      let meta;
      try {
        meta = await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }

      await table.createEntity({
        partitionKey: ticketId,
        rowKey: genMessageRowKey(),
        kind: 'time',
        authorName: user.name,
        authorUpn: user.upn,
        minutes,
        note,
        createdAt: new Date().toISOString(),
      });

      const totalTimeMinutes = (meta.totalTimeMinutes || 0) + minutes;
      await table.updateEntity({ partitionKey: ticketId, rowKey: '0', totalTimeMinutes }, 'Merge');

      audit(context, user, 'ticket.time', { ticketId, minutes });
      return { status: 201, jsonBody: { ok: true, totalTimeMinutes } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Merges a duplicate ticket into a primary one: every message/note/
// activity/time row (and their attachment blobs) is copied into the
// primary's partition with a rowKey that preserves its original
// chronological position, an activity entry on the primary records the
// merge, and the duplicate is then permanently deleted -- same full
// row+blob cleanup as ticketDelete, so nothing is left half-migrated. The
// primary's own meta (status/priority/assignee/rating/etc.) is left
// untouched except for its running time total, which absorbs the
// duplicate's; only the duplicate's THREAD content moves over.
app.http('ticketMerge', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tickets/{ticketId}/merge',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { ticketId: sourceId } = request.params; // the duplicate, merged away
      const body = await request.json().catch(() => ({}));
      const targetId = String(body.targetTicketId || '').trim();

      if (!targetId) throw new AuthError(400, 'targetTicketId is required');
      if (targetId === sourceId) throw new AuthError(400, 'Cannot merge a ticket into itself');

      await ensureTable();
      const table = getClient();

      // Both tickets must be real (a meta row present) -- same guard as
      // ticketDelete, for the same reason: reject a crafted id matching a
      // different reserved partition (CLIENT/CONFIG/RECURRING) before
      // touching it. This ALSO makes a retried/duplicate merge request
      // safe: once the source's meta row is gone (see the delete phase
      // below, which removes it first and separately), a second call for
      // the same sourceId hits this same check and 404s immediately,
      // rather than re-running the merge and duplicating everything.
      let sourceMeta, targetMeta;
      try {
        sourceMeta = await table.getEntity(sourceId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket to merge not found' } };
        throw e;
      }
      try {
        targetMeta = await table.getEntity(targetId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 400, jsonBody: { error: 'Target ticket not found' } };
        throw e;
      }

      let anyAttachmentCopyFailed = false;

      // Copies one source row into the target, migrating any attachments
      // it references. Returns the migrated row's key so the caller can
      // track which source rows are now safe to delete.
      async function migrateRow(row) {
        const newRow = {
          partitionKey: targetId,
          rowKey: genMessageRowKeyAt(row.createdAt),
          kind: row.kind,
          createdAt: row.createdAt,
        };
        if (row.kind === 'message' || row.kind === 'note') {
          newRow.authorType = row.authorType;
          newRow.authorName = row.authorName;
          newRow.authorUpn = row.authorUpn || '';
          newRow.body = row.body;
          newRow.attachmentsJson = '';
          const oldAttachments = parseAttachments(row.attachmentsJson);
          if (oldAttachments.length) {
            const newAttachments = [];
            for (const a of oldAttachments) {
              try {
                newAttachments.push(await copyAttachmentToTicket(sourceId, a, targetId));
              } catch (e2) {
                // One broken/missing source blob shouldn't block the rest
                // of the merge -- that image just won't carry over, and
                // everything else still migrates normally. But it DOES
                // mean the source's blobs can't be blindly wiped later:
                // this specific attachment is only safe where it already
                // is until someone notices and re-attaches it by hand.
                anyAttachmentCopyFailed = true;
                context.log('MERGE_ATTACHMENT_COPY_FAILED ' + JSON.stringify({ sourceId, targetId, attachmentId: a.id, error: e2.message }));
              }
            }
            newRow.attachmentsJson = newAttachments.length ? JSON.stringify(newAttachments) : '';
          }
        } else if (row.kind === 'time') {
          newRow.authorName = row.authorName;
          newRow.authorUpn = row.authorUpn || '';
          newRow.minutes = row.minutes;
          newRow.note = row.note || '';
        } else {
          // 'activity' and any future kind -- copy just the body text
          // rather than guessing at a shape this code doesn't know yet.
          newRow.body = row.body;
        }
        await table.createEntity(newRow);
        return row.rowKey;
      }

      const migratedRowKeys = [];
      for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${odataEscape(sourceId)}'` } })) {
        if (e.rowKey === '0') continue; // meta row itself never migrates
        migratedRowKeys.push(await migrateRow(e));
      }

      // Attachment copying above is real network I/O and can take seconds
      // for several images -- re-check for any row written to the source
      // in that window (a client/staff reply landing mid-merge) so it
      // gets migrated too instead of silently surviving as an orphan once
      // the source is deleted below. Bounded to a few passes rather than
      // looping until quiescent, since an actively-written-to ticket
      // being merged at the same moment is already an edge case.
      for (let pass = 0; pass < 3; pass++) {
        const stragglers = [];
        for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${odataEscape(sourceId)}'` } })) {
          if (e.rowKey === '0' || migratedRowKeys.includes(e.rowKey)) continue;
          stragglers.push(e);
        }
        if (!stragglers.length) break;
        for (const row of stragglers) migratedRowKeys.push(await migrateRow(row));
      }

      const totalTimeMinutes = (targetMeta.totalTimeMinutes || 0) + (sourceMeta.totalTimeMinutes || 0);
      await table.updateEntity({ partitionKey: targetId, rowKey: '0', updatedAt: new Date().toISOString(), totalTimeMinutes }, 'Merge');
      await recordActivity(table, targetId, `${user.name || user.upn} merged ticket ${sourceId} ("${sourceMeta.subject}") into this ticket`);

      // Delete the meta row FIRST and separately -- this is what makes a
      // retried/duplicate merge request safely 404 (see the existence
      // check above) instead of re-running the whole merge. Any OTHER row
      // that then fails to delete is just leftover orphaned data in a
      // partition nobody can reach anymore (ticketGet/clientTicketGet
      // both require the meta row), the same acceptable trade-off
      // ticketDelete already makes.
      // Retried with backoff, not just a single try -- everything above
      // (row copies, totalTimeMinutes, activity entry) has already
      // happened, so a single transient failure here forcing a client
      // retry of the whole merge would re-run all of that a second time.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await table.deleteEntity(sourceId, '0');
          break;
        } catch (e) {
          if (e.statusCode === 404) break;
          if (attempt === 2) throw e;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      const results = await Promise.allSettled(migratedRowKeys.map((rowKey) => table.deleteEntity(sourceId, rowKey)));
      // Skip the blob wipe entirely if any attachment failed to copy --
      // an unmigrated image is only safe where it already is (under the
      // source's prefix) until someone notices and re-attaches it by
      // hand. A few orphaned blobs left behind is a storage-hygiene
      // issue; silently destroying an image nobody has a copy of anymore
      // is not an acceptable trade for keeping this automatic.
      if (!anyAttachmentCopyFailed) {
        await deleteAllAttachmentsForTicket(sourceId);
      } else {
        context.log('MERGE_BLOB_CLEANUP_SKIPPED ' + JSON.stringify({ sourceId, targetId }));
      }
      const realFailure = results.find((r) => r.status === 'rejected' && r.reason && r.reason.statusCode !== 404);

      audit(context, user, 'ticket.merge', { sourceId, targetId, rowCount: migratedRowKeys.length, partial: !!realFailure || anyAttachmentCopyFailed });
      if (realFailure) throw realFailure.reason;

      return { jsonBody: { ok: true, targetTicketId: targetId } };
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
          // or message/rfc822 (never attacker-declared, see attachments.js),
          // so this can't currently be promoted to text/html by sniffing --
          // but neither Azure's global security headers nor CSP reach API
          // responses, so this route sets its own rather than relying on
          // either. dispositionFor forces a download (never inline) for
          // anything that isn't a sniffed image, e.g. a .eml, whose body can
          // carry HTML/script.
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `${dispositionFor(attachmentId)}; filename="${attachmentId}"`,
        },
        body: result.buffer,
      };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
