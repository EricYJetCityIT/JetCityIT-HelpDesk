const crypto = require('crypto');
const { app } = require('@azure/functions');
const { getClient, ensureTable, genMessageRowKey, recordActivity } = require('../lib/tables');
const { sendMail, SUPPORT_MAILBOX, getInboxMessagesSince } = require('../lib/graph');
const { escapeHtml, replyBodyHtml } = require('../lib/html');
const { deleteAttachments } = require('../lib/attachments');
const { importEmailAttachments, describeNotImported, stripCidPlaceholders } = require('../lib/emailAttachments');
const { normalizeEmail } = require('../lib/clientAccess');
const { requireCronSecret, authErrorResponse } = require('../lib/auth');
const { withTickLease } = require('../lib/tickLease');
const { notifyStaffTeam } = require('../lib/staffBroadcast');

// Reserved partitions, same pattern as CLIENT/CONFIG/RECURRING elsewhere in
// this table -- neither row kind is 'meta', so neither surfaces in
// ticketsList, and ticketDelete/ticketMerge's "must have a real meta row"
// guards already protect both partition names for free.
const CONFIG_PARTITION = 'CONFIG';
const CURSOR_ROW = 'emailIngestCursor';
// One marker row per Graph message actually ingested (or deliberately
// skipped), keyed by a hash of the message id (Graph ids aren't guaranteed
// safe as a raw Table Storage RowKey). This is what makes it safe to
// re-fetch and re-walk the same messages on a retry after a failure --
// see the cursor-advancement comments below for why that's needed at all.
const DEDUP_PARTITION = 'EMAILDEDUP';
function dedupKey(messageId) {
  return crypto.createHash('sha256').update(String(messageId)).digest('hex');
}

// Every outbound email this app sends already embeds "[HD-YYYYMMDD-XXXX]"
// in its subject (confirmation, assignment, status-change, client-reply-
// notification emails all do this) -- so does a client's own reply, since
// mail clients preserve the rest of the subject line when prefixing
// "Re:"/"RE:"/"Fwd:". Matching on this bracketed id is how an inbound
// message gets tied back to a ticket.
const TICKET_ID_RE = /\[(HD-\d{8}-[A-Z0-9]{4})\]/;

// A reply landing on a ticket that's been Closed for a long time is more
// likely a stale thread than a real continuation (subject-line matching
// has no thread/conversation correlation to fall back on -- see
// AUTHORIZATION.md for why that's an accepted, documented limitation) --
// so it's recorded but NOT auto-reopened, matching the 30-day threshold
// track.html already uses to nudge a client toward filing a new ticket.
const STALE_CLOSED_DAYS = 30;

// How long an email's attachments are retried across polls when Graph or blob
// storage is failing transiently, before it goes through as text with a "not
// imported" note instead. Without a bound, one persistent outage would stall
// the cursor -- and every text-only reply behind it -- indefinitely.
const ATTACHMENT_RETRY_WINDOW_MS = 30 * 60 * 1000;
// Stop STARTING new messages once a poll has run this long. Azure Static Web
// Apps cuts an API request off at 45 seconds (its documented limit), and one
// message with pictures can itself take several seconds (attachment list,
// downloads, uploads, writes, two emails), so a backlog (after an outage)
// must not keep a poll going past that. The unprocessed rest just waits for
// the next poll, since the cursor only moves past what was actually handled.
const POLL_TIME_BUDGET_MS = 25 * 1000;

// Checks the shared helpdesk@ mailbox's Inbox for new messages and threads
// matching ones into the relevant ticket as a client reply -- lets a
// client just hit "reply" on a notification email instead of going
// through the tracking portal. Meant to be called every ~5 minutes by an
// Azure Logic App (see infra/README.md), with the GitHub Actions workflow
// (.github/workflows/scheduled-ticks.yml) only a slow backstop -- GitHub's
// cron actually fires every few hours. Called on a schedule rather than run
// as an Azure Timer Trigger -- Azure Static Web Apps' managed
// Functions integration only supports HTTP triggers (see the comment on
// requireCronSecret in lib/auth.js for the full story). Deliberately a
// poll, not a Graph webhook subscription: no clientState-signature
// verification / subscription-renewal machinery needed for a small team
// where a few minutes of latency on an email reply is completely
// unnoticed. Picture attachments (PNG/JPG/GIF/WEBP, including ones pasted
// into the body) are imported onto the ticket the same way a portal upload
// is -- see lib/emailAttachments.js; any other file type is left in the
// mailbox and flagged to staff, not silently dropped.
app.http('emailIngestCheck', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'internal/email-ingest-tick',
  handler: async (request, context) => {
    try {
      requireCronSecret(request);
      // One run at a time per job, and a heartbeat the staff console shows (lib/tickLease.js).
      const run = await withTickLease('email-ingest', context, async () => {
        await ensureTable();
        const table = getClient();

        let cursor;
        try {
          const row = await table.getEntity(CONFIG_PARTITION, CURSOR_ROW);
          cursor = row.since;
        } catch (e) {
          if (e.statusCode !== 404) throw e;
        }
        // First run ever (or a lost cursor) starts from a few minutes back,
        // not the mailbox's entire history -- turning this feature on
        // shouldn't suddenly ingest months of old inbox mail as replies.
        if (!cursor) cursor = new Date(Date.now() - 10 * 60 * 1000).toISOString();

        const messages = await getInboxMessagesSince(cursor);
        // The cursor only ever advances past a message once it's been
        // durably handled (processed or deliberately skipped) -- NOT just
        // because it was fetched. Comparing via getTime() rather than raw
        // ISO strings, since the bootstrap fallback above (3 fractional
        // digits) and Graph's own receivedDateTime (7 fractional digits)
        // don't compare correctly as plain strings.
        let safeCursor = cursor;
        let processedCount = 0;
        // Handled-but-failed work, reported to the heartbeat (lib/tickLease.js): a message that keeps
        // failing holds the cursor, so everything behind it waits -- the console must not say "OK".
        let problems = 0;
        let problem = '';
        const deadline = Date.now() + POLL_TIME_BUDGET_MS;

        for (const msg of messages) {
          if (Date.now() > deadline) {
            context.log('EMAIL_INGEST_TIME_BUDGET_REACHED ' + JSON.stringify({ processedCount, fetched: messages.length }));
            break;
          }
          const key = dedupKey(msg.id);
          let alreadyHandled = false;
          try {
            await table.getEntity(DEDUP_PARTITION, key);
            alreadyHandled = true;
          } catch (e) {
            if (e.statusCode !== 404) {
              // Can't tell whether this was already handled -- stop rather
              // than risk either skipping or duplicating it.
              context.log('EMAIL_INGEST_DEDUP_CHECK_FAILED ' + JSON.stringify({ messageId: msg.id, error: e.message }));
              problems++;
              problem = 'could not check the mailbox bookkeeping; waiting emails are held (see logs)';
              break;
            }
          }

          if (!alreadyHandled) {
            try {
              await processInboundMessage(table, context, msg);
            } catch (e) {
              // A genuine failure -- stop here. Everything from this message
              // onward gets retried on the next poll, since the cursor never
              // advances past it.
              context.log('EMAIL_INGEST_MESSAGE_FAILED ' + JSON.stringify({ messageId: msg.id, error: e.message }));
              problems++;
              problem = 'an emailed reply could not be processed; later emails are held behind it (see logs)';
              break;
            }
            try {
              await table.createEntity({ partitionKey: DEDUP_PARTITION, rowKey: key, kind: 'config', processedAt: new Date().toISOString() });
            } catch (e) {
              // Best-effort -- if just this marker write fails, the worst
              // case is this one message gets reprocessed (and its side
              // effects duplicated) on a future retry. A far better trade
              // than treating a failed marker write the same as a failed
              // processing attempt and blocking the cursor here too.
              context.log('EMAIL_INGEST_DEDUP_MARK_FAILED ' + JSON.stringify({ messageId: msg.id, error: e.message }));
            }
            processedCount++;
          }

          if (msg.receivedDateTime && new Date(msg.receivedDateTime).getTime() > new Date(safeCursor).getTime()) {
            safeCursor = msg.receivedDateTime;
          }
        }

        await table.upsertEntity({ partitionKey: CONFIG_PARTITION, rowKey: CURSOR_ROW, kind: 'config', since: safeCursor }, 'Merge');
        if (processedCount) context.log('EMAIL_INGEST_PROCESSED ' + JSON.stringify({ count: processedCount }));
        return { ok: true, processedCount, problems, problem };
      });
      if (run.skipped) return { jsonBody: { ok: true, skipped: true } };
      return { jsonBody: run.result };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

async function processInboundMessage(table, context, msg) {
  const fromAddress = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '';
  if (!fromAddress) return;

  // CRITICAL: this mailbox is also where the app sends every internal
  // notification it generates about itself -- "Client replied", "SLA
  // breach", "Assigned" for a recurring ticket (whose synthetic requester
  // email IS this same shared mailbox) all arrive `from: SUPPORT_MAILBOX,
  // to: SUPPORT_MAILBOX`, right into this same Inbox, and often contain a
  // "[ticketId]" in their own subject. Without this check, the poller
  // would treat the app's own notification emails as inbound client
  // replies, re-posting their HTML as a "reply", reopening the ticket,
  // which triggers ANOTHER notification email back to this same inbox --
  // a real, self-sustaining loop. The shared support mailbox is never a
  // legitimate "client" sender for any real ticket, so this is a safe
  // blanket rule, not a narrower per-ticket check.
  if (normalizeEmail(fromAddress) === normalizeEmail(SUPPORT_MAILBOX)) return;

  const subject = msg.subject || '';
  const match = subject.match(TICKET_ID_RE);
  if (!match) return; // not a reply to any known ticket -- ignore silently (spam, newsletters, unrelated mail all land in this shared inbox too)
  const ticketId = match[1];

  let meta;
  try {
    meta = await table.getEntity(ticketId, '0');
  } catch (e) {
    if (e.statusCode === 404) return; // ticket id in the subject doesn't exist (anymore) -- ignore
    throw e;
  }

  // The From: address is the entire trust boundary here -- same as every
  // other email-based support system (Zendesk, Freshdesk, etc.). Actual
  // spoofing resistance comes from SPF/DKIM/DMARC enforcement on the
  // receiving side (Microsoft 365), which this code has no visibility
  // into; this check only ensures a message that legitimately reached
  // this inbox from someone OTHER than the ticket's own requester never
  // gets attributed to them.
  if (normalizeEmail(fromAddress) !== normalizeEmail(meta.email)) {
    context.log('EMAIL_INGEST_SENDER_MISMATCH ' + JSON.stringify({ ticketId, from: fromAddress }));
    return;
  }

  const rawText = String((msg.uniqueBody && msg.uniqueBody.content) || '');
  let bodyText = stripCidPlaceholders(rawText).trim().slice(0, 5000);

  // Subject-line matching has no notion of "this reply is actually part of
  // the SAME conversation" -- a client reusing a months-old notification
  // email (or a mail client auto-threading under it) with unrelated new
  // content would otherwise silently reopen and pollute a long-closed,
  // possibly-rated ticket. Recorded either way (nothing is dropped), but a
  // stale-closed ticket is left Closed rather than auto-reopened, and the
  // staff notification flags it for manual triage instead of reading as a
  // routine continuation.
  const isStaleClosed = meta.status === 'Closed' &&
    (Date.now() - new Date(meta.resolvedAt || meta.updatedAt).getTime()) > STALE_CLOSED_DAYS * 86400000;

  const fromName = (msg.from && msg.from.emailAddress && msg.from.emailAddress.name) || fromAddress;

  // Stored BEFORE the message row, like a portal upload, so the row can point
  // at them. Always looked for on a verified reply rather than gated on
  // Graph's hasAttachments (false when the only attachments are inline
  // pictures -- exactly a pasted screenshot) or on a "[cid:" placeholder in
  // the text (which a client can render as alt text instead): one small
  // Graph call per genuine reply. A permanent problem with an attachment never
  // throws (see importEmailAttachments); a transient one does, so this message
  // is retried on the next poll -- until it's old enough that it goes through
  // as text with a "not imported" note instead.
  const ageMs = msg.receivedDateTime ? Date.now() - new Date(msg.receivedDateTime).getTime() : 0;
  const imported = await importEmailAttachments(ticketId, msg.id, rawText, { giveUp: ageMs > ATTACHMENT_RETRY_WINDOW_MS });
  const notImported = describeNotImported(imported);
  // No text, and no picture of the sender's either (e.g. just quoted history, an
  // auto-reply with no real text, or an unreferenced signature logo): nothing new.
  if (!bodyText && !imported.stored.length && !notImported) return;
  // An email that was ONLY attachments we couldn't import would otherwise
  // become a blank message in the client's thread; say what happened instead.
  if (!bodyText && !imported.stored.length) bodyText = '(Email with no message text -- its attachment(s) could not be added to the ticket.)';

  const now = new Date().toISOString();
  const messageRowKey = genMessageRowKey();
  try {
    await table.createEntity({
      partitionKey: ticketId,
      rowKey: messageRowKey,
      kind: 'message',
      authorType: 'client',
      authorName: fromName,
      authorUpn: '',
      body: bodyText,
      attachmentsJson: imported.stored.length ? JSON.stringify(imported.stored) : '',
      createdAt: now,
    });

    // Same reopen-field-clearing as clientTicketReply (clientPortal.js) --
    // a rating/resolvedAt/firstRespondedAt/escalatedAt all answer for a
    // SPECIFIC episode of the ticket, so reopening it invalidates them.
    const update = { partitionKey: ticketId, rowKey: '0', updatedAt: now };
    if (meta.status !== 'Open' && !isStaleClosed) {
      update.status = 'Open';
      if (meta.rating) { update.rating = ''; update.ratedAt = ''; }
      if (meta.resolvedAt) update.resolvedAt = '';
      if (meta.firstRespondedAt) update.firstRespondedAt = '';
      if (meta.escalatedAt) update.escalatedAt = '';
    }
    await table.updateEntity(update, 'Merge');
  } catch (e) {
    await deleteAttachments(ticketId, imported.stored);
    await table.deleteEntity(ticketId, messageRowKey).catch(() => {});
    throw e;
  }

  await recordActivity(table, ticketId, `Reply received by email from ${fromAddress}` + (isStaleClosed ? ' (ticket left Closed -- more than 30 days old, needs manual review)' : ''));
  // Staff-only trail (clients never see activity rows): the sender attached
  // something we didn't bring across, and the original is still in the
  // helpdesk@ mailbox if it matters.
  if (notImported) await recordActivity(table, ticketId, `Email attachment(s) not imported: ${notImported} -- the original is still in the helpdesk@ mailbox`);

  // Same note on both staff emails below.
  const notImportedHtml = notImported
    ? `<p><em>Not imported: ${escapeHtml(notImported)} -- still in the helpdesk@ mailbox.</em></p>`
    : '';

  try {
    const staleNote = isStaleClosed
      ? `<p><em>This ticket was closed over ${STALE_CLOSED_DAYS} days ago and was NOT automatically reopened -- please review whether this is a genuine continuation or should be a new ticket.</em></p>`
      : '';
    const html = `<p>Client reply (by email) on ticket ${escapeHtml(ticketId)} (${escapeHtml(meta.subject)}):</p>
${staleNote}${replyBodyHtml(bodyText, imported.stored.length)}${notImportedHtml}
<p><a href="https://helpdesk.jetcityit.com/staff.html?ticket=${encodeURIComponent(ticketId)}">Open in staff console</a></p>`;
    const subjectPrefix = isStaleClosed ? 'Reply on an old closed ticket' : 'Client replied';
    await sendMail({ from: SUPPORT_MAILBOX, to: SUPPORT_MAILBOX, subject: `${subjectPrefix}: ${meta.subject} [${ticketId}]`, html });
  } catch (e) {
    context.log('EMAIL_INGEST_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
  }

  // Goes to every staff member's own inbox, unlike the SUPPORT_MAILBOX
  // notification above -- this poller only ever scans SUPPORT_MAILBOX's
  // own Inbox, so a broadcast landing in each staff member's personal
  // mailbox instead can never be picked back up as a fake "reply" by this
  // same loop.
  await notifyStaffTeam(context, {
    subject: `Requester replied: ${meta.subject} [${ticketId}]`,
    html: `<p>${escapeHtml(fromName)} replied (by email) on ticket ${escapeHtml(ticketId)}:</p>
${replyBodyHtml(bodyText, imported.stored.length)}${notImportedHtml}
<p><a href="https://helpdesk.jetcityit.com/staff.html?ticket=${encodeURIComponent(ticketId)}">Open in the staff console</a></p>`,
  });
}
