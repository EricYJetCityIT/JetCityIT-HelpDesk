const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse } = require('../lib/auth');
const { audit } = require('../lib/audit');
const { isValidDomain } = require('../lib/domain');
const { listAllDomainsWithAccounts, setDomainEnabled, deleteAccount } = require('../lib/orgUsers');

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
      const domain = String(request.params.domain || '').trim().toLowerCase();
      const email = String(request.params.email || '').trim().toLowerCase();
      if (!isValidDomain(domain)) throw new AuthError(400, 'Invalid domain.');
      if (!email) throw new AuthError(400, 'Invalid email.');

      await deleteAccount(domain, email);

      audit(context, user, 'org.admin.account.delete', { domain, email });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
