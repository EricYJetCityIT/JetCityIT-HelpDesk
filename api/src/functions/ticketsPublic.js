const { app } = require('@azure/functions');
const { getClient, ensureTable, genTicketId, genMessageRowKey } = require('../lib/tables');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');

const MAX_LEN = { name: 120, email: 200, company: 150, subject: 200, description: 5000 };

function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || 'unknown';
}

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
        createdAt: now,
      });

      audit(context, null, 'ticket.create', { ticketId, ip });

      return { status: 201, jsonBody: { ticketId } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
  },
});
