const TENANT_ID = process.env.AAD_TENANT_ID;
const CLIENT_ID = process.env.AAD_CLIENT_ID;

// Shared mailbox all outbound help-desk email sends from (and, for
// client-reply staff notifications, the address it sends TO as well --
// staff already have it added as a shared mailbox in Outlook).
const SUPPORT_MAILBOX = 'helpdesk@jetcityit.com';

let cachedToken = null; // { accessToken, expiresAt }

// App-only (client-credentials) Graph token. A staff reply has no delegated
// user token to borrow (the caller signed in for OUR api scope, not Graph),
// so this authenticates as the app itself instead -- same approach as the
// crew-calendar app's availability-reminder job. Requires the "JetCity
// Availability App" registration to have an application-level Mail.Send
// permission (already admin-consented there) and a client secret set here as
// MAIL_CLIENT_SECRET -- both created by hand in the Azure Portal, never by
// code. Reuses the same App Registration as AAD_CLIENT_ID/AAD_TENANT_ID.
async function getAppToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.accessToken;
  const clientSecret = process.env.MAIL_CLIENT_SECRET;
  if (!clientSecret) throw new Error('MAIL_CLIENT_SECRET is not configured');
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph token error ${res.status}: ${text}`);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

// Sends mail as `from`, which must be a real mailbox (user or shared
// mailbox) -- a plain distribution list has no message store and app-only
// sendMail will fail against one.
async function sendMail({ from, to, subject, html }) {
  const token = await getAppToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph sendMail error ${res.status}: ${text}`);
  }
}

// Looks up display names for a list of UPNs -- used to label the staff
// assignee dropdown. Reuses the same App Registration's already-consented
// application-level User.Read.All permission (originally set up for the
// crew-calendar app; confirmed present when checking API permissions for
// this feature, so no new consent grant was needed). Best-effort per user:
// a lookup failure for one UPN (e.g. a disabled/removed account still
// listed in STAFF_UPNS) degrades to a null name rather than failing the
// whole list.
async function getUsersByUpns(upns) {
  const token = await getAppToken();
  return Promise.all(
    upns.map(async (upn) => {
      try {
        const res = await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}?$select=displayName`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) return { upn, name: null };
        const data = await res.json();
        return { upn, name: data.displayName || null };
      } catch (e) {
        return { upn, name: null };
      }
    })
  );
}

module.exports = { sendMail, getUsersByUpns, SUPPORT_MAILBOX };
