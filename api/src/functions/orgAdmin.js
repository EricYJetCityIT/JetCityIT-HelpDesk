const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse } = require('../lib/auth');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const { isValidDomain } = require('../lib/domain');
const { listAllDomainsWithAccounts, setDomainEnabled, setAccountDisabled, deleteAccount, getAccount } = require('../lib/orgUsers');
const { sendPasswordResetEmail } = require('../lib/orgEmails');

// Shared by the three account-level actions below (delete, disable/enable,
// reset-password): validates the domain/email URL params, confirms the
// account exists AND actually belongs to the domain named in the URL
// (getAccount looks it up by the email's own domain, which the URL's
// {domain} segment doesn't otherwise constrain, so a mismatched URL can't
// silently act on the wrong client's account), and applies a shared
// per-target rate limit -- unlike the anonymous org/* endpoints (each of
// which pairs an IP + per-email checkRateLimit), these mutating actions
// would otherwise rely solely on requireStaff's own generic per-UPN cap,
// which is shared across every staff action app-wide and does nothing to
// stop one target account from being hit repeatedly.
async function resolveAccountAction(request) {
  const domain = String(request.params.domain || '').trim().toLowerCase();
  const email = String(request.params.email || '').trim().toLowerCase();
  if (!isValidDomain(domain)) throw new AuthError(400, 'Invalid domain.');
  if (!email) throw new AuthError(400, 'Invalid email.');

  const limit = checkRateLimit('org-admin-account-action:' + email, 10, 60 * 60 * 1000);
  if (!limit.allowed) throw new AuthError(429, 'Too many actions on this account -- please slow down.', { retryAfterSec: limit.retryAfterSec });

  const account = await getAccount(email);
  if (!account || account.partitionKey !== domain) throw new AuthError(404, 'Account not found');

  return { domain, email, account };
}

// Staff-only visibility into every domain that has ever been enabled or
// signed up for the team portal (not just currently-enabled ones), plus
// each domain's accounts -- lets staff answer "did Dan actually sign up
// yet?" without needing direct Table Storage access.
app.http('orgAdminDomainsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'org/admin/domains',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const domains = await listAllDomainsWithAccounts();
      audit(context, user, 'org.admin.domains.list', { count: domains.length });
      return { jsonBody: { domains } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Enables or disables the team portal for one client domain. Disabling
// immediately blocks sign-in for every account on that domain (checked in
// orgPortal.js's requireOrgSession) without deleting any of them -- a
// client can be re-enabled later with no re-signup needed.
app.http('orgAdminDomainSet', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/admin/domains/{domain}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const domain = String(request.params.domain || '').trim().toLowerCase();
      if (!isValidDomain(domain)) throw new AuthError(400, 'Invalid domain.');

      const body = await request.json().catch(() => ({}));
      const enabled = !!body.enabled;
      await setDomainEnabled(domain, enabled, user.upn);

      audit(context, user, 'org.admin.domain.set', { domain, enabled });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Permanently removes one team-portal account -- the lever for cutting off
// a single departed or compromised person without disabling the whole
// domain (setDomainEnabled above). Deleting the row invalidates both that
// account's session token and its password in one step; they'd need a
// brand-new sign-up (and re-verification) to get back in.
app.http('orgAdminAccountDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'org/admin/domains/{domain}/accounts/{email}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { domain, email } = await resolveAccountAction(request);

      await deleteAccount(domain, email);

      audit(context, user, 'org.admin.account.delete', { domain, email });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Disables or re-enables one account -- a reversible, lighter-weight lever
// than deleting it outright (above). Disabling is checked on every request
// (orgPortal.js's requireOrgSession), so it kicks the person out of an
// already-open session immediately, not just their next sign-in, AND clears
// the session token itself (setAccountDisabled in orgUsers.js) so
// re-enabling later can never silently revive a session that was valid
// before the disable. The password and account history are left intact for
// whenever they're re-enabled.
app.http('orgAdminAccountSetDisabled', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/admin/domains/{domain}/accounts/{email}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { domain, email } = await resolveAccountAction(request);

      const body = await request.json().catch(() => ({}));
      const disabled = !!body.disabled;
      await setAccountDisabled(domain, email, disabled, user.upn);

      audit(context, user, 'org.admin.account.setDisabled', { domain, email, disabled });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Emails the account holder a link to set a brand-new password (same
// "prove inbox ownership" model as email verification -- see
// orgResetPassword in orgPortal.js) -- there's no self-service "forgot
// password" entry point yet, so this staff action is currently the only
// way a locked-out user gets back in short of a whole new sign-up.
app.http('orgAdminAccountResetPassword', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'org/admin/domains/{domain}/accounts/{email}/reset-password',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { domain, email, account } = await resolveAccountAction(request);

      await sendPasswordResetEmail(account.name, email, domain, context);

      audit(context, user, 'org.admin.account.resetPassword', { domain, email });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
