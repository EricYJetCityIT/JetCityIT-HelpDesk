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
const { sendVerificationEmail } = require('../lib/orgEmails');
const { getClient: getTicketsClient, ensureTable: ensureTicketsTable, genMessageRowKey, recordActivity, applyTicketRating } = require('../lib/tables');
const { findTicketsByDomain } = require('../lib/clientAccess');
const { createTicket } = require('../lib/ticketCreation');
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
  // A disabled account is a real account staff have deliberately cut off
  // (see orgAdmin.js) -- checked on every request, not just at login, so
  // disabling someone kicks them out of an already-open session immediately
  // rather than only blocking their next sign-in.
  if (account.disabled) throw new AuthError(403, 'This account has been disabled. Contact Jet City IT for help.');
  if (!account.verified) throw new AuthError(403, 'Account not verified.');
  if (!domainEnabled) throw new AuthError(403, 'Organization portal access is not currently enabled for this organization.');
  const issuedAt = account.sessionIssuedAt ? new Date(account.sessionIssuedAt).getTime() : 0;
  if (!issuedAt || Date.now() - issuedAt > SESSION_MAX_AGE_MS) {
    throw new AuthError(403, 'Your session has expired -- please sign in again.');
  }
  return { email: normalized, name: account.name, domain };
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
    // Lets the frontend offer a "my tickets" filter without a second API
    // round trip -- no new exposure since every teammate on this domain
    // can already see requesterName for every ticket in the shared list.
    requesterEmail: e.email,
    rating: e.rating || null,
    // Who rated it -- unlike the individual portal, more than one teammate
    // could plausibly rate the same ticket, so the ticket itself needs to
    // say who, not just what.
    ratedByName: e.ratedByName || null,
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
        throw new AuthError(403, 'Organization portal sign-up isn\'t available for this email domain yet -- contact Jet City IT to have it enabled for your organization.');
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
          await sendVerificationEmail(existing.name, email, domain, context);
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
        await sendVerificationEmail(name, email, domain, context);
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
            await sendVerificationEmail(account.name, email, emailDomain(email), context);
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

// Self-service entry point for someone who can't sign in: rather than
// emailing a reset link directly (which would need its own token-issuing
// endpoint to secure), this files a real, visible ticket -- reusing the
// exact same ticket-creation flow the public form uses (createTicket),
// including its own auto-assignment + staff notification email -- and
// leaves the actual reset to a technician, who fulfills it with the
// existing orgAdminAccountResetPassword button (which emails a proper
// single-use reset link). Same generic {ok:true} response regardless of
// whether the email matches a real account, same enumeration-avoidance
// spirit as signup/resend-verification above.
app.http('orgRequestPasswordReset', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/request-password-reset',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const ipLimit = checkRateLimit('org-reqreset-ip:' + ip, 10, 60 * 60 * 1000);
      if (!ipLimit.allowed) {
        return { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) }, jsonBody: { ok: true } };
      }

      const body = await request.json().catch(() => ({}));
      const email = normalizeEmail(body.email);
      if (!email) return { jsonBody: { ok: true } };

      // Tight per-email cap -- this both files a ticket and emails the
      // requester, so without a limit here it's a way to spam a coworker's
      // inbox and flood the ticket queue just by knowing their address, not
      // just a login/enumeration concern.
      const emailLimit = checkRateLimit('org-reqreset-email:' + email, 3, 60 * 60 * 1000);
      if (!emailLimit.allowed) return { jsonBody: { ok: true } };

      const domain = emailDomain(email);
      if (!domain || !isValidDomain(domain)) return { jsonBody: { ok: true } };

      // Independent lookups, run concurrently -- same pattern as
      // requireOrgSession, which these two checks below are mirroring.
      const [account, domainEnabled] = await Promise.all([getAccount(email), isDomainEnabled(domain)]);
      // A disabled account or a domain staff have revoked must not be able
      // to generate a real ticket + notification emails through this
      // self-service entry point, any more than they could sign in, reset
      // their password via a staff-issued link, or keep an existing session
      // alive -- requireOrgSession/orgLogin/orgResetPassword all enforce
      // the same two checks; this is the one org/* endpoint that touches an
      // account without them.
      if (!account || account.disabled || !domainEnabled) return { jsonBody: { ok: true } };

      const requesterName = account.name || email;
      // Written in the requester's own voice -- this becomes the ticket's
      // first client-authored message, and (once they regain access) is
      // visible to them via their own tracking-link email or org portal
      // ticket list, same as any other ticket. Staff-facing fulfillment
      // instructions go on a separate internal activity-log entry below
      // instead of into this message, since that's read by staff only.
      const ticketId = await createTicket({
        name: requesterName,
        email,
        company: domain,
        subject: `Password reset request -- ${email}`,
        description: "I'm unable to sign in to the organization portal and would like my password reset.",
        category: 'Account Access',
        priority: 'High',
        context,
        auditExtra: { domain, ip, source: 'org.requestPasswordReset' },
      });
      await recordActivity(getTicketsClient(), ticketId, 'Self-service password reset request -- use "Reset password" in Organization Portal admin to fulfill.');
      // Surfaces on the account row in the admin view itself, not just
      // buried in the ticket queue -- so a staff member scanning the
      // Organization Portal admin list can see who's waiting without
      // needing to separately notice a matching ticket. Best-effort and
      // isolated from the response: the ticket is already fully created
      // and both notification emails already sent by this point, so a
      // hiccup on this bookkeeping write (or the account row having been
      // deleted in the interim) must never turn an already-successful
      // request into a reported failure -- that would just invite a
      // retry that piles up a duplicate ticket.
      try {
        await ensureTable();
        await getClient().updateEntity({ partitionKey: domain, rowKey: email, resetRequestedAt: new Date().toISOString() }, 'Merge');
      } catch (e) {
        context.log('ORG_SET_RESET_FLAG_FAILED ' + JSON.stringify({ domain, email, error: e.message }));
      }
      return { jsonBody: { ok: true } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
  },
});

// Consumes a reset token a staff member triggered (orgAdmin.js's
// reset-password action) and sets a new password. Anonymous -- the token
// itself, emailed only to the account's own address, is what proves this
// is the real account owner (same "prove inbox ownership" model as
// verification), not a signed-in session.
app.http('orgResetPassword', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/reset-password',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('org-resetpw-ip:' + ip, 10, 60 * 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const body = await request.json().catch(() => ({}));
      const email = normalizeEmail(body.email);
      const token = String(body.token || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 10) throw new AuthError(400, 'Password must be at least 10 characters.');

      const account = await getAccount(email);
      if (!account || !account.resetToken || !safeTokenEqual(account.resetToken, token)) {
        throw new AuthError(403, 'Invalid or expired reset link.');
      }
      // A disabled account shouldn't be able to change its own credentials
      // via a reset link -- login/requireOrgSession already re-check this
      // (so a disabled account still couldn't sign in even without this
      // guard), but allowing the reset to silently succeed anyway would
      // contradict "Disable" reading as a full freeze.
      if (account.disabled) throw new AuthError(403, 'This account has been disabled. Contact Jet City IT for help.');

      const domain = emailDomain(email);
      const passwordHash = await hashPassword(newPassword);
      await ensureTable();
      // Also clears any existing session -- a password reset should force
      // re-authentication with the new password everywhere, not leave a
      // session from before the reset (e.g. on a device that prompted it)
      // still valid.
      await getClient().updateEntity(
        { partitionKey: domain, rowKey: email, passwordHash, resetToken: '', sessionToken: '', sessionIssuedAt: '', resetRequestedAt: '' },
        'Merge'
      );

      audit(context, null, 'org.resetPassword', { domain });
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
      if (account.disabled) throw new AuthError(403, 'This account has been disabled. Contact Jet City IT for help.');
      if (!account.verified) throw new AuthError(403, 'Please verify your email before signing in -- check your inbox for the verification link.');
      if (!domainEnabled) throw new AuthError(403, 'Organization portal access is not currently enabled for this organization.');

      const sessionToken = genToken();
      const now = new Date().toISOString();
      await ensureTable();
      // resetRequestedAt cleared here too -- a successful sign-in (with
      // whatever password they used) means the account is no longer
      // actually locked out, so a stale flag shouldn't keep showing in the
      // admin view as if a reset were still pending.
      await getClient().updateEntity(
        { partitionKey: domain, rowKey: email, sessionToken, sessionIssuedAt: now, lastSignInAt: now, resetRequestedAt: '' },
        'Merge'
      );

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

// Lets a signed-in org account file a brand-new ticket on their own
// organization's behalf, rather than only viewing/replying to ones that
// already exist -- reuses the same createTicket path (and therefore the
// same auto-assignment and staff notification email) as the public form
// and the password-reset-request flow, but with notifyRequester:false --
// unlike those two, this requester is already signed into a live view of
// this exact ticket, so the usual confirmation + tracking-link email
// would just be redundant. requireOrgSession is the entire authorization
// boundary here (no separate honeypot/category-of-caller distinction is
// needed the way the anonymous public form needs one): a valid session
// already proves this is a verified person at an enabled domain, so
// name/email/company come from the session, never the request body.
app.http('orgTicketCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/tickets',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      // Same 10/min-per-IP budget as orgTicketReply -- both are
      // session-authenticated writes with attachments, so the same abuse
      // shape (a compromised account, or several people behind one office
      // NAT) applies equally to both.
      const rl = checkRateLimit('org-ticketcreate-ip:' + ip, 10, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;

      const creds = readOrgCreds(request);
      const session = await requireOrgSession(creds.email, creds.sessionToken);

      const body = await request.json().catch(() => ({}));
      const subject = String(body.subject || '').trim();
      const description = String(body.description || '').trim();
      if (!subject || !description) throw new AuthError(400, 'Subject and description are required.');

      let ticketId;
      try {
        ticketId = await createTicket({
          name: session.name,
          email: session.email,
          company: session.domain,
          subject,
          description,
          category: body.category,
          attachments: body.attachments,
          context,
          auditExtra: { domain: session.domain, source: 'org.ticketCreate' },
          // The requester is already signed into the org portal and sees
          // this ticket in their shared list immediately -- the usual
          // confirmation + individual tracking-link email would just be
          // redundant (and mint a separate, weaker per-person credential
          // nobody asked for), unlike the public form or a password-reset
          // request, where it's the requester's only way to track things.
          notifyRequester: false,
        });
      } catch (e) {
        if (e instanceof AttachmentError) throw new AuthError(400, e.message);
        throw e;
      }

      // Staff-visible signal (shown in the ticket's activity trail, same
      // as "Auto-assigned to X") that this came from a verified, signed-in
      // teammate rather than the anonymous public form -- otherwise
      // nothing on the ticket itself distinguishes the two once created.
      await recordActivity(getTicketsClient(), ticketId, `Filed via Organization Portal by ${session.name} (${session.domain})`);

      return { status: 201, jsonBody: { ticketId } };
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
          if (meta.rating) { update.rating = ''; update.ratedAt = ''; update.ratedByEmail = ''; update.ratedByName = ''; }
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
        const html = `<p>Organization portal reply on ticket ${escapeHtml(ticketId)} (${escapeHtml(meta.subject)}) from <strong>${escapeHtml(session.name)}</strong> (${escapeHtml(session.domain)}):</p>
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

// Same 1-tap Yes/No satisfaction rating as the individual client portal's
// clientTicketRating -- shares that endpoint's fetch/status-gate/merge
// core via applyTicketRating (../lib/tables.js), supplying only its own
// ownership predicate (a domain match here, not an email+token pair) and
// its own audit action. Any teammate on the domain can rate any ticket,
// deliberately extending the same shared reply/view model this whole file
// already uses (any teammate can already reply to, or view attachments
// on, any ticket the team filed) rather than narrowing ratings to "only
// the original requester" -- these are internal IT tickets a team
// resolves together, not a public CSAT survey, so team consensus is an
// acceptable substitute for exactly one person's opinion. The real risk
// that model raises -- one teammate silently overwriting another's
// answer with no record of who did it or that it changed -- is mitigated
// by storing ratedByEmail/ratedByName (via applyTicketRating's
// extraFields), unlike the individual portal's rating, which has no such
// ambiguity to begin with (there's only ever one possible rater).
app.http('orgTicketRating', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/tickets/{ticketId}/rating',
  handler: async (request, context) => {
    try {
      const ip = clientIp(request);
      const rl = checkRateLimit('org-rating-ip:' + ip, 20, 60 * 1000);
      if (!rl.allowed) {
        return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many requests.' } };
      }

      const creds = readOrgCreds(request);
      const session = await requireOrgSession(creds.email, creds.sessionToken);

      const body = await request.json().catch(() => ({}));
      const rating = String(body.rating || '');
      if (rating !== 'yes' && rating !== 'no') throw new AuthError(400, 'Invalid rating');

      const { ticketId } = request.params;
      await ensureTicketsTable();
      const table = getTicketsClient();

      const result = await applyTicketRating(
        table,
        ticketId,
        rating,
        (meta) => emailDomain(meta.email) === session.domain,
        { ratedByEmail: session.email, ratedByName: session.name }
      );
      if (result.status === 'not_found') return { status: 404, jsonBody: { error: 'Ticket not found' } };
      if (result.status === 'not_resolved') throw new AuthError(400, 'This ticket has not been resolved yet.');
      audit(context, null, 'ticket.orgRate', { ticketId, domain: session.domain, rating });

      return { jsonBody: { ok: true } };
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
