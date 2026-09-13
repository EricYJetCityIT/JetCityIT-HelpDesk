const { getClient, ensureTable, genTicketId, genMessageRowKey, TICKET_CATEGORIES, recordActivity } = require('./tables');
const { checkRateLimit } = require('./ratelimit');
const { audit } = require('./audit');
const { sendMail, SUPPORT_MAILBOX } = require('./graph');
const { escapeHtml } = require('./html');
const { getOrCreateClientToken, buildTrackingLink } = require('./clientAccess');
const { storeAttachments, deleteAttachments, AttachmentError } = require('./attachments');
const { STAFF_UPNS } = require('./auth');

// Shared by the public ticket-submission form (ticketsPublic.js) and any
// other server-side flow that needs to create a real ticket on someone's
// behalf -- e.g. the Organization Portal's "Request a password reset"
// (orgPortal.js), which files a ticket + relies on this function's own
// auto-assignment notification to alert staff, rather than resetting
// anything directly itself. Everything from here down (auto-assignment,
// activity logging, the assignee notification email, the requester's
// confirmation + tracking-link email) is identical regardless of how the
// ticket's fields were sourced, so callers only need to supply already-
// validated field values.
const MAX_LEN = { name: 120, email: 200, company: 150, subject: 200, description: 5000 };

// staff.html reads ?ticket= on load and opens that ticket directly instead
// of the list -- same helper as tickets.js's buildStaffTicketLink, kept as
// its own tiny copy here rather than a shared export since it's one line.
function buildStaffTicketLink(ticketId) {
  return `https://helpdesk.jetcityit.com/staff.html?ticket=${encodeURIComponent(ticketId)}`;
}

// Round-robin assignment on new tickets. State lives in a single row under
// a reserved 'CONFIG' partition -- kind is deliberately not 'meta', so it
// never surfaces in ticketsList's kind==='meta' filter, and ticketDelete's
// "must have a real meta row" guard already protects this partition name
// from the same class of bug that guard was added to fix. Not perfectly
// race-safe if two tickets are created in the same instant (both could
// read the same index before either writes back) -- an acceptable fairness
// blip at this volume, not a correctness issue, so no optimistic-
// concurrency retry loop here.
async function pickNextAssignee(table) {
  if (!STAFF_UPNS.length) return '';
  let nextIndex = 0;
  try {
    const row = await table.getEntity('CONFIG', 'roundRobin');
    nextIndex = Number(row.nextIndex) || 0;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const assignee = STAFF_UPNS[nextIndex % STAFF_UPNS.length];
  await table.upsertEntity({ partitionKey: 'CONFIG', rowKey: 'roundRobin', kind: 'config', nextIndex: nextIndex + 1 }, 'Merge');
  return assignee;
}

// Best-effort pre-triage only -- staff can always change priority by hand in
// the console, so a false positive here just means one ticket sits in the
// High filter a little too generously, and a false negative just means a
// human has to notice it like any other ticket. Never treated as
// authoritative or used for anything security-sensitive.
const HIGH_PRIORITY_KEYWORDS = [
  'urgent', 'asap', 'emergency', 'critical', 'outage', 'down', "can't work",
  'cannot work', 'not working', 'security breach', 'hacked', 'ransomware',
  'data loss', 'production down',
];

function autoTriagePriority(subject, description) {
  const text = (subject + ' ' + description).toLowerCase();
  return HIGH_PRIORITY_KEYWORDS.some((kw) => text.indexOf(kw) !== -1) ? 'High' : 'Normal';
}

// Creates a real ticket (meta + first message row), auto-assigns it,
// notifies the assignee (best-effort, rate-limited), and emails the
// requester a confirmation + tracking link (best-effort) -- the exact same
// side effects a public form submission has. Fields are re-capped to the
// same MAX_LEN limits ticketsCreate itself enforces, so a caller that
// doesn't (e.g. one building a name from stored account data) can't write
// an oversized value even if it forgets to trim first. Throws
// AttachmentError if `attachments` fails validation; any other throw means
// nothing was written (attachments already uploaded for this ticket are
// cleaned up first).
async function createTicket({ name, email, company, subject, description, category, priority, attachments, context, auditExtra }) {
  name = String(name || '').trim().slice(0, MAX_LEN.name);
  email = String(email || '').trim().slice(0, MAX_LEN.email);
  company = String(company || '').trim().slice(0, MAX_LEN.company);
  subject = String(subject || '').trim().slice(0, MAX_LEN.subject);
  description = String(description || '').trim().slice(0, MAX_LEN.description);
  const validCategory = TICKET_CATEGORIES.includes(category) ? category : 'Other';
  // Callers that already know a ticket is high-stakes by construction (e.g.
  // an account-lockout request) can say so directly -- autoTriagePriority
  // is keyword-based and can't be expected to infer that from generated
  // text the way it can from a real person's own description.
  const validPriority = priority === 'High' ? 'High' : autoTriagePriority(subject, description);

  await ensureTable();
  const table = getClient();
  const ticketId = genTicketId();
  const now = new Date().toISOString();

  // AttachmentError or otherwise -- nothing written yet, caller decides how to surface it
  const storedAttachments = await storeAttachments(ticketId, attachments);

  // Best-effort -- a Table Storage hiccup on the round-robin counter must
  // never block a ticket from being created; it just falls back to
  // unassigned, same as if auto-assignment didn't exist.
  let assignee = '';
  try {
    assignee = await pickNextAssignee(table);
  } catch (e) {
    context.log('AUTO_ASSIGN_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
  }

  try {
    await table.createEntity({
      partitionKey: ticketId,
      rowKey: '0',
      kind: 'meta',
      status: 'Open',
      priority: validPriority,
      category: validCategory,
      name,
      email,
      company,
      subject,
      assignee,
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
      attachmentsJson: storedAttachments.length ? JSON.stringify(storedAttachments) : '',
      createdAt: now,
    });
  } catch (e) {
    // The attachments already uploaded successfully -- if the ticket itself
    // then fails to persist, don't leave those blobs behind referencing a
    // ticket that will never exist.
    await deleteAttachments(ticketId, storedAttachments);
    throw e;
  }

  audit(context, null, 'ticket.create', { ticketId, ...auditExtra });

  if (assignee) {
    await recordActivity(table, ticketId, `Auto-assigned to ${assignee}`);
    // This can be reached from a PUBLIC, unauthenticated caller -- the
    // 5/min-per-IP submit limit on the public form doesn't stop a
    // distributed or slow-and-steady flood from riding the round-robin to
    // spam every staff member in turn. A per-assignee cap (generous for
    // real usage, well below what sustained abuse would produce) keeps the
    // notification useful without becoming an inbox-flooding vector. The
    // assignment and activity entry above still happen regardless -- only
    // the email is capped.
    const notifyLimit = checkRateLimit('assign-notify:' + assignee, 20, 60 * 60 * 1000);
    if (notifyLimit.allowed) {
      try {
        const html = `<p>You've been auto-assigned a new ticket:</p>
<p><strong>${escapeHtml(subject)}</strong><br/>Ticket ${escapeHtml(ticketId)}</p>
<p><a href="${escapeHtml(buildStaffTicketLink(ticketId))}">Open in the staff console</a></p>`;
        await sendMail({ from: SUPPORT_MAILBOX, to: assignee, subject: `Assigned: ${subject} [${ticketId}]`, html });
      } catch (e) {
        context.log('ASSIGN_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
      }
    }
  }

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

  return ticketId;
}

module.exports = { createTicket, MAX_LEN, AttachmentError };
