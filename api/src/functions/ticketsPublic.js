const { app } = require('@azure/functions');
const { getClient, ensureTable, genTicketId, genMessageRowKey, TICKET_CATEGORIES, recordActivity } = require('../lib/tables');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { escapeHtml } = require('../lib/html');
const { getOrCreateClientToken, buildTrackingLink } = require('../lib/clientAccess');
const { storeAttachments, deleteAttachments, rejectIfTooLarge, AttachmentError } = require('../lib/attachments');
const { clientIp } = require('../lib/ip');
const { STAFF_UPNS } = require('../lib/auth');

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

const MAX_LEN = { name: 120, email: 200, company: 150, subject: 200, description: 5000 };

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
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
      // Not required -- an empty/invalid value just falls back to "Other"
      // rather than blocking submission over a field that's mainly for
      // staff-side reporting/routing.
      const category = TICKET_CATEGORIES.includes(body.category) ? body.category : 'Other';

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

      // Best-effort -- a Table Storage hiccup on the round-robin counter
      // must never block a ticket from being created; it just falls back
      // to unassigned, same as if auto-assignment didn't exist.
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
          priority: autoTriagePriority(subject, description),
          category,
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

      if (assignee) {
        await recordActivity(table, ticketId, `Auto-assigned to ${assignee}`);
        // This is the one email this PUBLIC, unauthenticated endpoint can
        // send to a specific real staff mailbox -- the 5/min-per-IP submit
        // limit doesn't stop a distributed or slow-and-steady flood from
        // riding the round-robin to spam every staff member in turn. A
        // per-assignee cap (generous for real usage, well below what
        // sustained abuse would produce) keeps the notification useful
        // without becoming an inbox-flooding vector. The assignment and
        // activity entry above still happen regardless -- only the email
        // is capped.
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

      return { status: 201, jsonBody: { ticketId } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
  },
});
