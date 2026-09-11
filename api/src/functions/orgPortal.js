const { app } = require('@azure/functions');
const { AuthError, authErrorResponse } = require('../lib/auth');
const { checkRateLimit } = require('../lib/ratelimit');
const { clientIp } = require('../lib/ip');
const { escapeHtml } = require('../lib/html');
const { sendMail, SUPPORT_MAILBOX } = require('../lib/graph');
const { audit } = require('../lib/audit');
const { odataEscape } = require('../lib/odata');
const { isValidDomain } = require('../lib/domain');
const {
  getClient,
  ensureTable,
  normalizeEmail,
  emailDomain,
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
  SESSION_MAX_AGE_MS,
  genToken,
  safeTokenEqual,
  isDomainEnabled,
  getAccount,
} = require('../lib/orgUsers');
const { getClient: getTicketsClient, ensureTable: ensureTicketsTable, genMessageRowKey } = require('../lib/tables');
const { findTicketsByDomain } = require('../lib/clientAccess');
const {
  storeAttachments,
  deleteAttachments,
  downloadAttachment,
  parseAttachments,
  rejectIfTooLarge,
  dispositionFor,
  AttachmentError,
} = require('../lib/attachments');

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Reads the {email, sessionToken} credential pair every org/* route (other
// than signup/verify/login themselves) is called with. Always headers, not
// a query string or URL -- a team-portal session is a much higher-value
// credential than the individual client portal's per-email token (it
// grants an entire organization's ticket history, not one person's own
// tickets), so it never travels anywhere it could end up in browser
// history, address-bar autocomplete, or a proxy/access log.
function readOrgCreds(request) {
  return {
    email: request.headers.get('x-org-email') || '',
    sessionToken: request.headers.get('x-org-session') || '',
  };
}

// Verifies that pair, that the account is verified, that its domain is
// still opted into the team portal (staff can revoke a whole client's
// access by disabling the domain without touching any individual account),
// and that the session hasn't outlived SESSION_MAX_AGE_MS. Returns the
// minimal identity the caller needs.
async function requireOrgSession(email, sessionToken) {
  const normalized = normalizeEmail(email);
  const domain = emailDomain(normalized);
  // Independent lookups -- neither depends on the other's result -- run
  // concurrently rather than as two sequential round trips on every
  // single org/* request.
  const [account, domainEnabled] = await Promise.all([getAccount(normalized), isDomainEnabled(domain)]);
  if (!account || !account.sessionToken || !safeTokenEqual(account.sessionToken, sessionToken)) {
    throw new AuthError(403, 'Invalid session -- please sign in again.');
  }
  if (!account.verified) throw new AuthError(403, 'Account not verified.');
  if (!domainEnabled) throw new AuthError(403, 'Team portal access is not currently enabled for this organization.');
  const issuedAt = account.sessionIssuedAt ? new Date(account.sessionIssuedAt).getTime() : 0;
  if (!issuedAt || Date.now() - issuedAt > SESSION_MAX_AGE_MS) {
    throw new AuthError(403, 'Your session has expired -- please sign in again.');
  }
  return { email: normalized, name: account.name, domain };
}

// Shared by signup (new account) and resend-verification (an existing,
// still-unverified one) -- regenerates the token each time so an old,
// possibly-leaked verification email stops working once a new one is sent.
async function issueVerificationEmail(name, email, domain, context) {
  const verifyToken = genToken();
  await ensureTable();
  await getClient().updateEntity({ partitionKey: domain, rowKey: email, verifyToken }, 'Merge');
  const link = `https://helpdesk.jetcityit.com/team.html?verifyEmail=${encodeURIComponent(email)}&verifyToken=${encodeURIComponent(verifyToken)}`;
  try {
    const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Confirm your email to finish setting up Jet City IT team portal access for <strong>${escapeHtml(domain)}</strong>:</p>
<p><a href="${escapeHtml(link)}">Verify my account</a></p>
<p>If you didn't request this, you can safely ignore this email.</p>
<p>— Jet City IT Help Desk</p>`;
    await sendMail({ from: SUPPORT_MAILBOX, to: email, subject: 'Verify your Jet City IT team portal account', html });
  } catch (e) {
    context.log('ORG_VERIFY_EMAIL_FAILED ' + JSON.stringify({ email, error: e.message }));
  }
}

function ticketToOrgJson(e) {
  return {
    ticketId: e.partitionKey,
    status: e.status,
    priority: e.priority,
    category: e.category || 'Other',
    subject: e.subject,
    // Unlike the individual client portal (always "your own" tickets), a
    // shared team view needs to say WHICH teammate originally filed each
    // one -- this is the one field that genuinely differs from
    // clientPortal.js's ticketToClientJson, so it isn't reused as-is.
    requesterName: e.name,
    rating: e.rating || null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

// Staff messages are attributed to the help desk as a whole (same as the
// individual portal). Client-side messages, though, name the actual
// teammate who wrote them -- "you" (the individual portal's wording) would
// be actively misleading here, since any of several different people could
// have posted into the same shared thread.
function messageToOrgJson(m) {
  return {
    from: m.authorType === 'staff' ? 'staff' : 'client',
    authorName: m.authorType === 'staff' ? 'Jet City IT Help Desk' : m.authorName,
    body: m.body,
    attachments: parseAttachments(m.attachmentsJson),
    createdAt: m.createdAt,
  };
}

// ── Signup ──
app.http('orgSignup', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/signup',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const ipLimit = checkRateLimit('org-signup-ip:' + ip, 10, 60 * 60 * 1000);
      if (!ipLimit.allowed) {
        return { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const body = await request.json().catch(() => ({}));
      const name = String(body.name || '').trim().slice(0, 200);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');

      if (!name) throw new AuthError(400, 'Name is required.');
      if (!isValidEmail(email)) throw new AuthError(400, 'A valid email is required.');
      const domain = emailDomain(email);
      if (!domain || !isValidDomain(domain)) throw new AuthError(400, 'A valid work email is required.');
      if (password.length < 10) throw new AuthError(400, 'Password must be at least 10 characters.');

      const emailLimit = checkRateLimit('org-signup-email:' + email, 5, 60 * 60 * 1000);
      if (!emailLimit.allowed) throw new AuthError(429, 'Too many requests -- please slow down.', { retryAfterSec: emailLimit.retryAfterSec });

      if (!(await isDomainEnabled(domain))) {
        throw new AuthError(403, 'Team portal sign-up isn\'t available for this email domain yet -- contact Jet City IT to have it enabled for your organization.');
      }

      // From here on, every path returns the exact same {ok:true} response
      // -- an email that's already registered (verified or not) responds
      // identically to a brand-new one, so this endpoint can't be used to
      // enumerate which coworkers have already signed up (the same
      // enumeration-avoidance orgLogin and orgResendVerification already
      // apply, extended to cover signup too).
      const existing = await getAccount(email);
      if (existing) {
        if (!existing.verified) {
          // Not verified yet -- the common cause is a lost/expired first
          // email, not someone else's account, so resend rather than
          // silently doing nothing.
          await issueVerificationEmail(existing.name, email, domain, context);
        }
        return { jsonBody: { ok: true } };
      }

      const passwordHash = await hashPassword(password);
      await ensureTable();
      let created = true;
      try {
        await getClient().createEntity({
          partitionKey: domain,
          rowKey: email,
          name,
          passwordHash,
          verified: false,
          verifyToken: '',
          sessionToken: '',
          sessionIssuedAt: '',
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        // Lost a race with a concurrent signup for the same brand-new
        // email -- the winner's own request already creates the account
        // and sends its own verification email, so this one just no-ops
        // into the same generic response as any other "already exists"
        // case above, rather than surfacing the 409 as a bare 500.
        if (e.statusCode !== 409) throw e;
        created = false;
      }

      if (created) {
        await issueVerificationEmail(name, email, domain, context);
        audit(context, null, 'org.signup', { domain });
      }
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('orgResendVerification', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/resend-verification',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const ipLimit = checkRateLimit('org-resend-ip:' + ip, 10, 60 * 60 * 1000);
      if (!ipLimit.allowed) {
        return { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) }, jsonBody: { ok: true } };
      }

      const body = await request.json().catch(() => ({}));
      const email = normalizeEmail(body.email);
      if (email) {
        const emailLimit = checkRateLimit('org-resend-email:' + email, 3, 60 * 60 * 1000);
        // Always the same {ok:true} response either way (rate-limited,
        // no such account, already verified, or actually sent) -- doesn't
        // reveal which, same "generic response" spirit as the individual
        // portal's own /client/access endpoint.
        if (emailLimit.allowed) {
          const account = await getAccount(email);
          if (account && !account.verified) {
            await issueVerificationEmail(account.name, email, emailDomain(email), context);
          }
        }
      }
      return { jsonBody: { ok: true } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
  },
});

app.http('orgVerify', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/verify',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('org-verify-ip:' + ip, 20, 60 * 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const body = await request.json().catch(() => ({}));
      const email = normalizeEmail(body.email);
      const token = String(body.token || '');
      const account = await getAccount(email);
      if (!account || !account.verifyToken || !safeTokenEqual(account.verifyToken, token)) {
        throw new AuthError(403, 'Invalid or expired verification link.');
      }

      const domain = emailDomain(email);
      await ensureTable();
      await getClient().updateEntity(
        { partitionKey: domain, rowKey: email, verified: true, verifyToken: '', verifiedAt: new Date().toISOString() },
        'Merge'
      );
      audit(context, null, 'org.verify', { domain });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// ── Login / logout ──
app.http('orgLogin', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/login',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const ipLimit = checkRateLimit('org-login-ip:' + ip, 20, 15 * 60 * 1000);
      if (!ipLimit.allowed) {
        return { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const body = await request.json().catch(() => ({}));
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!email || !password) throw new AuthError(400, 'Email and password are required.');

      const emailLimit = checkRateLimit('org-login-email:' + email, 8, 15 * 60 * 1000);
      if (!emailLimit.allowed) throw new AuthError(429, 'Too many requests -- please slow down.', { retryAfterSec: emailLimit.retryAfterSec });

      const domain = emailDomain(email);
      // Independent lookups run concurrently -- domain-enabled status
      // doesn't depend on the account or password at all.
      const [account, domainEnabled] = await Promise.all([getAccount(email), isDomainEnabled(domain)]);
      // Runs the SAME expensive password check whether or not an account
      // exists -- otherwise a nonexistent email responds measurably faster
      // than a real one with a wrong password, letting an attacker
      // enumerate valid team-portal emails purely by timing.
      const passwordOk = await verifyPassword(password, account ? account.passwordHash : DUMMY_PASSWORD_HASH);
      if (!account || !passwordOk) throw new AuthError(401, 'Invalid email or password.');
      if (!account.verified) throw new AuthError(403, 'Please verify your email before signing in -- check your inbox for the verification link.');
      if (!domainEnabled) throw new AuthError(403, 'Team portal access is not currently enabled for this organization.');

      const sessionToken = genToken();
      await ensureTable();
      await getClient().updateEntity({ partitionKey: domain, rowKey: email, sessionToken, sessionIssuedAt: new Date().toISOString() }, 'Merge');

      audit(context, null, 'org.login', { domain });
      return { jsonBody: { name: account.name, domain, sessionToken } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('orgLogout', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/logout',
  handler: async (request, context) => {
    try {
      const { email: rawEmail, sessionToken } = readOrgCreds(request);
      const email = normalizeEmail(rawEmail);
      const domain = emailDomain(email);
      if (domain && sessionToken) {
        try {
          await requireOrgSession(email, sessionToken);
          await ensureTable();
          await getClient().updateEntity({ partitionKey: domain, rowKey: email, sessionToken: '' }, 'Merge');
        } catch (e) {
          // An already-invalid/expired session just means "nothing to log
          // out of" -- idempotent no-op, not an error. A real (non-auth)
          // failure still surfaces below.
          if (!(e instanceof AuthError)) throw e;
        }
      }
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// ── Tickets (domain-scoped) ──
app.http('orgTicketsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'org/tickets',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('org-view-ip:' + ip, 60, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const creds = readOrgCreds(request);
      const session = await requireOrgSession(creds.email, creds.sessionToken);
      const tickets = (await findTicketsByDomain(session.domain))
        .map(ticketToOrgJson)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return { jsonBody: { tickets } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('orgTicketGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'org/tickets/{ticketId}',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('org-view-ip:' + ip, 60, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const creds = readOrgCreds(request);
      const session = await requireOrgSession(creds.email, creds.sessionToken);
      const { ticketId } = request.params;
      await ensureTicketsTable();
      const table = getTicketsClient();

      let meta = null;
      const messages = [];
      for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${odataEscape(ticketId)}'` } })) {
        if (e.kind === 'meta') meta = e;
        else if (e.kind === 'message') messages.push(e);
      }
      // Domain match is the entire ownership boundary here -- a session
      // for one client's domain must never resolve a ticket belonging to
      // a different one, even by guessed/typo'd id.
      if (!meta || emailDomain(meta.email) !== session.domain) {
        return { status: 404, jsonBody: { error: 'Ticket not found' } };
      }

      messages.sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1));
      return { jsonBody: { ...ticketToOrgJson(meta), messages: messages.map(messageToOrgJson) } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('orgTicketReply', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/tickets/{ticketId}/replies',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('org-reply-ip:' + ip, 10, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;

      const creds = readOrgCreds(request);
      const session = await requireOrgSession(creds.email, creds.sessionToken);

      const body = await request.json().catch(() => ({}));
      const text = String(body.body || '').trim().slice(0, 5000);
      if (!text) throw new AuthError(400, 'Reply body is required');

      const { ticketId } = request.params;
      await ensureTicketsTable();
      const table = getTicketsClient();

      let meta;
      try {
        meta = await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Ticket not found' } };
        throw e;
      }
      if (emailDomain(meta.email) !== session.domain) {
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
          authorName: session.name,
          authorUpn: '',
          body: text,
          attachmentsJson: attachments.length ? JSON.stringify(attachments) : '',
          createdAt: now,
        });

        // A team-portal reply reopens the ticket exactly like the
        // individual client portal's own reply does, and for the same
        // reason: a rating/resolution-time/first-response/escalation all
        // answer for one specific resolved episode, invalidated by
        // reopening it.
        const update = { partitionKey: ticketId, rowKey: '0', updatedAt: now };
        if (meta.status !== 'Open') {
          update.status = 'Open';
          if (meta.rating) { update.rating = ''; update.ratedAt = ''; }
          if (meta.resolvedAt) update.resolvedAt = '';
          if (meta.firstRespondedAt) update.firstRespondedAt = '';
          if (meta.escalatedAt) update.escalatedAt = '';
        }
        await table.updateEntity(update, 'Merge');
      } catch (e) {
        await deleteAttachments(ticketId, attachments);
        await table.deleteEntity(ticketId, messageRowKey).catch(() => {});
        throw e;
      }

      audit(context, null, 'ticket.orgReply', { ticketId, domain: session.domain });

      try {
        const html = `<p>Team portal reply on ticket ${escapeHtml(ticketId)} (${escapeHtml(meta.subject)}) from <strong>${escapeHtml(session.name)}</strong> (${escapeHtml(session.domain)}):</p>
<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>
<p><a href="https://helpdesk.jetcityit.com/staff.html">Open in staff console</a></p>`;
        await sendMail({ from: SUPPORT_MAILBOX, to: SUPPORT_MAILBOX, subject: `Client replied: ${meta.subject} [${ticketId}]`, html });
      } catch (e) {
        context.log('ORG_REPLY_STAFF_NOTIFY_FAILED ' + JSON.stringify({ ticketId, error: e.message }));
      }

      return { status: 201, jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('orgAttachmentGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'org/tickets/{ticketId}/attachments/{attachmentId}',
  handler: async (request, context) => {
    try {
      // Its own bucket, separate from orgTicketsList/orgTicketGet's
      // 'org-view-ip' -- same reasoning as the individual portal's
      // clientAttachmentGet: viewing one ticket's images can cost several
      // requests, and shouldn't 429 an unrelated teammate behind the same
      // office NAT/proxy who's just trying to see their own ticket list.
      const ip = clientIp(request);
      const rl = checkRateLimit('org-attachment-ip:' + ip, 120, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const creds = readOrgCreds(request);
      const session = await requireOrgSession(creds.email, creds.sessionToken);
      const { ticketId, attachmentId } = request.params;
      await ensureTicketsTable();
      const table = getTicketsClient();
      let meta;
      try {
        meta = await table.getEntity(ticketId, '0');
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Attachment not found' } };
        throw e;
      }
      if (emailDomain(meta.email) !== session.domain) {
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
          'Content-Disposition': `${dispositionFor(attachmentId)}; filename="${attachmentId}"`,
        },
        body: result.buffer,
      };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
