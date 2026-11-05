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
// sendMail will fail against one. `to` is normally a single address, but
// also accepts an array -- one message with everyone in the To line (e.g.
// broadcasting an event to the whole staff team), not one send per
// recipient.
async function sendMail({ from, to, subject, html }) {
  const token = await getAppToken();
  const recipients = (Array.isArray(to) ? to : [to]).map((address) => ({ emailAddress: { address } }));
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: recipients,
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

// One directory user, for the Access tab's "add this person" check. Returns
// null when no such account exists (404) and throws on anything else, so the
// caller can tell "that person isn't in the directory" (reject) from "couldn't
// ask right now" (try again). Looked up by the exact sign-in name -- the same
// value the staff sign-in check matches (the token's preferred_username).
// `upn` in the result is Graph's own canonical, lowercased userPrincipalName,
// which is what gets stored, rather than whatever was typed.
async function getUserByUpn(upn) {
  const token = await getAppToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}?$select=displayName,userPrincipalName,accountEnabled`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph get-user error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return {
    upn: String(data.userPrincipalName || '').trim().toLowerCase(),
    name: data.displayName || null,
    enabled: data.accountEnabled !== false,
  };
}

// The company directory (enabled accounts only) for the Access tab's "Name or
// email" picker. Uses the same already-consented User.Read.All permission as
// the lookups above. Follows Graph's paging, with a hard cap so a runaway
// response can't loop forever.
async function listDirectoryUsers() {
  const token = await getAppToken();
  let url = 'https://graph.microsoft.com/v1.0/users?$select=displayName,userPrincipalName,accountEnabled&$filter=' +
    encodeURIComponent('accountEnabled eq true') + '&$top=999';
  const out = [];
  for (let page = 0; url && page < 10; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Graph list-users error ${res.status}: ${text}`);
    }
    const data = await res.json();
    (data.value || []).forEach((u) => {
      if (u.accountEnabled === false) return;
      const upn = String(u.userPrincipalName || '').trim().toLowerCase();
      if (upn) out.push({ upn, name: u.displayName || null });
    });
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

// Polls the shared support mailbox's Inbox for messages received after a
// given timestamp -- used by the email-ingest timer to pick up client
// replies sent directly to a notification email instead of through the
// tracking portal. `Prefer: outlook.body-content-type="text"` makes Graph
// return uniqueBody as plain text instead of HTML, sidestepping the need
// to strip markup ourselves. uniqueBody is Graph's own "just the new
// content, quoted history already stripped" property -- much more
// reliable than trying to detect "On ... wrote:" boundaries by hand.
// `sinceIso` is always our own previously-stored cursor, never
// user-controlled input, so it's safe to interpolate directly into the
// OData filter.
async function getInboxMessagesSince(sinceIso) {
  const token = await getAppToken();
  const filter = `receivedDateTime gt ${sinceIso}`;
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SUPPORT_MAILBOX)}/mailFolders/Inbox/messages` +
    `?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$select=id,subject,from,receivedDateTime,uniqueBody,hasAttachments&$top=50`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.body-content-type="text"',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph list-messages error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.value || [];
}

// Bound on each attachment-related Graph call, so one stalled response can't
// hang an entire email poll (a plain fetch has no timeout of its own).
const GRAPH_ATTACHMENT_TIMEOUT_MS = 30000;

// An Error that carries the HTTP status (and Retry-After, if Graph sent one),
// so a caller can tell a throttle/outage worth retrying from a permanent
// failure like a missing permission -- see lib/emailAttachments.js.
async function graphError(label, res) {
  const text = await res.text().catch(() => '');
  return Object.assign(new Error(`${label} ${res.status}: ${text}`), { status: res.status, retryAfter: res.headers.get('retry-after') });
}

// Attachment METADATA for one inbox message (no file contents -- a PDF or a
// 20 MB photo shouldn't be pulled down just to find out it isn't wanted).
// `messageId` comes from Graph's own list response above, never from user
// input, but is still URL-encoded since Graph ids contain `=`/`-`/`_`.
// Inline images (a screenshot pasted into the email body) are included here
// too, which is the whole reason this exists: Graph's `hasAttachments` flag
// is false for a message whose only attachments are inline.
async function listMessageAttachments(messageId) {
  const token = await getAppToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SUPPORT_MAILBOX)}/messages/${encodeURIComponent(messageId)}/attachments` +
    `?$select=id,name,contentType,size,isInline&$top=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(GRAPH_ATTACHMENT_TIMEOUT_MS) });
  if (!res.ok) throw await graphError('Graph list-attachments error', res);
  const data = await res.json();
  return data.value || [];
}

// One attachment in full: for a file attachment this carries `contentBytes`
// (base64) and `contentId` (the "cid:" an inline image is referenced by in
// the email body), neither of which the metadata listing above returns.
async function getMessageAttachment(messageId, attachmentId) {
  const token = await getAppToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SUPPORT_MAILBOX)}/messages/${encodeURIComponent(messageId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(GRAPH_ATTACHMENT_TIMEOUT_MS) });
  if (!res.ok) throw await graphError('Graph get-attachment error', res);
  return res.json();
}

// The same unique (new, quoted-history-stripped) body as the message poll
// reads, but as HTML. The poll's plain-text version only shows an inline image
// as a "[cid:...]" placeholder some of the time; in the HTML the reference is
// always an <img src="cid:...">, which is what decides whether an inline
// picture belongs to what the sender just wrote.
async function getMessageUniqueBodyHtml(messageId) {
  const token = await getAppToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SUPPORT_MAILBOX)}/messages/${encodeURIComponent(messageId)}?$select=uniqueBody`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="html"' },
    signal: AbortSignal.timeout(GRAPH_ATTACHMENT_TIMEOUT_MS),
  });
  if (!res.ok) throw await graphError('Graph get-body error', res);
  const data = await res.json();
  return (data.uniqueBody && data.uniqueBody.content) || '';
}

module.exports = { sendMail, getUsersByUpns, getUserByUpn, listDirectoryUsers, getInboxMessagesSince, listMessageAttachments, getMessageAttachment, getMessageUniqueBodyHtml, SUPPORT_MAILBOX };
