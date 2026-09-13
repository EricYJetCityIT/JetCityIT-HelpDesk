const { app } = require('@azure/functions');
const { genTicketId, TICKET_CATEGORIES } = require('../lib/tables');
const { checkRateLimit } = require('../lib/ratelimit');
const { rejectIfTooLarge, AttachmentError } = require('../lib/attachments');
const { clientIp } = require('../lib/ip');
const { createTicket, MAX_LEN } = require('../lib/ticketCreation');

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
      // Not required -- an empty/invalid value just falls back to "Other"
      // rather than blocking submission over a field that's mainly for
      // staff-side reporting/routing.
      const category = TICKET_CATEGORIES.includes(body.category) ? body.category : 'Other';

      if (!name || !isValidEmail(email) || !subject || !description) {
        return { status: 400, jsonBody: { error: 'Name, a valid email, subject, and description are required.' } };
      }

      let ticketId;
      try {
        ticketId = await createTicket({
          name, email, company, subject, description, category,
          attachments: body.attachments, context, auditExtra: { ip },
        });
      } catch (e) {
        if (e instanceof AttachmentError) return { status: 400, jsonBody: { error: e.message } };
        throw e;
      }

      return { status: 201, jsonBody: { ticketId } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
  },
});
