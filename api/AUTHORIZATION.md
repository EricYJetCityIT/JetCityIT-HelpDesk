# API Authorization

## Access model

| Capability | Who |
|---|---|
| **Submit** a ticket (`POST /api/tickets`) | Anyone — no sign-in. Rate-limited by IP (5/min) plus a honeypot field. |
| **View / list / update tickets, reply (staff console)** | Only accounts on the `STAFF_UPNS` allowlist |
| **View / reply to own tickets (client tracking page)** | Anyone holding a valid per-email access token — see below |

There is no intermediate "read-only staff" tier — being on `STAFF_UPNS` is the
entire access boundary for everything under `/api/tickets*` besides ticket
creation. Enforcement is server-side (in the Functions); the frontend hiding
the console for non-staff is a convenience, not the security boundary.

## Who is "staff"?

Same quick-start pattern as the crew-calendar app's `EDITOR_UPNS`: a
comma-separated allowlist app setting, checked against the signed-in user's
UPN (email). No app-registration change needed to add or remove someone.

```
STAFF_UPNS = dylanm@jetcityit.com,ericy@jetcityit.com,alex@jetcityit.com,simone@jetcityit.com
```

To add or remove staff: Static Web App (`jetcityit-helpdesk`) → **Configuration**
→ edit `STAFF_UPNS` → Save. Takes effect on the next request, no redeploy.

## Sign-in

Reuses the **same Azure AD App Registration** as the crew-calendar app
("JetCity Availability App", client id `b367d366-39f5-4fdc-a5e9-9d634ca37b5e`,
tenant `a2b534e7-8d8b-4c5f-ae4b-5076fd677ff4`) — just with additional SPA
redirect URIs registered for this site's origins (`/` and `/staff.html`, for
both the `*.azurestaticapps.net` default hostname and `helpdesk.jetcityit.com`).
No new app registration, no new admin consent.

## Client ticket tracking (`/track.html`, `api/client/*`)

Clients aren't `@jetcityit.com` accounts and ticket submission itself is
unauthenticated (no email verification), so ticket IDs and email addresses
alone can't serve as a secret — a ticket ID only has ~1.7M possible values
and is easily guessable. Instead, each client email gets one persistent
random access token (`api/src/lib/clientAccess.js`, stored in the `Tickets`
table under partition `CLIENT`), and that token is **only ever delivered by
emailing it to the address it belongs to** — never returned directly in an
API response. The real inbox owner is the only one who ever sees it, which
is what actually proves the requester controls that address.

The token rides along automatically:
- In the ticket-submission confirmation email (`POST /api/tickets`)
- In every staff-reply notification email (`POST /api/tickets/{id}/replies`)
- Or on request, via `POST /api/client/access {email}` from `/track.html`'s
  "track your tickets" form — always returns the same generic response
  whether or not that email has tickets, and is rate-limited both per-IP and
  per-target-email so it can't be used to spam a stranger's inbox.

`GET /api/client/tickets` and `GET /api/client/tickets/{id}` take `email` +
`token` query params, validate the token, and additionally re-check that the
ticket's own `email` field matches — so a valid token for one address can
never unlock a ticket filed under a different one, even by guessed ID.
`POST /api/client/tickets/{id}/replies` (`email`, `token`, `body`) lets the
client add to the thread; this reopens the ticket to `Open` if it wasn't
already, and best-effort emails a staff notification (to `helpdesk@`
itself, since staff already have it as a shared mailbox).

Client-facing responses omit internal fields (`assignee`, staff UPNs) —
staff messages are attributed simply to "Jet City IT Help Desk", not the
individual technician.

## Image attachments

Clients and staff can both attach up to 4 images (PNG/JPEG/GIF/WEBP, 10 MB
each, 20 MB combined) to a ticket-creation, staff-reply, or client-reply
request — sent as base64 in the same JSON body (`attachments: [{fileName,
dataBase64}]`), not a separate upload call. Storage/validation lives in
`api/src/lib/attachments.js`.

- **Never trust the client's declared type.** Every upload is classified by
  its actual file-signature bytes (`sniffImageType`), and the *sniffed* type
  is what gets stored and served — a request claiming `image/png` for
  anything else is rejected outright. `image/svg+xml` is deliberately not a
  supported type: an SVG can carry a `<script>`, making it an XSS vector the
  moment it's rendered or linked to.
- **Blob names are always server-generated** (random 24-hex-char id + a
  whitelisted extension), never derived from the client's filename — the
  filename is kept only as a display label (HTML-escaped on render, length-
  capped), never used to build a storage path.
- **Storage is a private Blob container** (`attachments`, in the same
  storage account as the `Tickets` table, created with no `access` option =
  no anonymous read) in the *same* storage account as the `Tickets` table.
  There is no direct/public blob URL anywhere in the frontend — every image
  is streamed back through an authenticated Function endpoint that applies
  the exact same authorization as viewing the ticket itself:
  - Staff: `GET /api/tickets/{id}/attachments/{attachmentId}` — gated by
    `requireStaff`, same as every other staff route.
  - Client: `GET /api/client/tickets/{id}/attachments/{attachmentId}?email=&token=`
    — validates the token AND re-checks the ticket's `email` matches, so a
    valid token for one address can never fetch another client's images.
- The staff console fetches attachment bytes via the bearer-token-authed
  `apiFetchBlob` helper and displays them via `blob:` object URLs (CSP
  `img-src` includes `blob:` for this). The client portal's token travels in
  the query string already, so it uses a plain `<img src>` pointed straight
  at the download URL — no JS-fetch indirection needed there.
- Known limitation: attachments are never deleted (no ticket-deletion
  feature exists yet either), so blob storage grows unbounded over time —
  acceptable at this volume/cost, revisit if that changes.

**Hardening applied after an adversarial security review** of this feature
(10 findings confirmed, all addressed):
- `Content-Length` is checked and the request rejected (413) *before*
  `request.json()` ever reads/parses the body, on all three
  attachment-accepting endpoints — otherwise an oversized body would be
  fully buffered/parsed in memory before any size check could run.
- If any file partway through a batch fails validation, or the Table
  Storage write that actually attaches the stored files to a ticket/message
  fails afterward, the already-uploaded blobs for that request are deleted
  rather than left as permanent orphans (`deleteAttachments`).
- The staff-reply endpoint now confirms the ticket exists *before* storing
  attachments or writing the message row (matching the client-reply
  endpoint's ordering) — previously a typo'd/made-up ticket ID could still
  upload real blobs into a partition with no meta row to ever surface them.
- Both attachment-download responses set `X-Content-Type-Options: nosniff`
  and `Content-Disposition: inline` explicitly — Azure's global security
  headers (`staticwebapp.config.json`) don't reach API/Function responses
  at all, so these routes no longer implicitly relied on that.
- `clientIp()` (`api/src/lib/ip.js`, shared by every rate-limited route) now
  reads the *last* `X-Forwarded-For` entry instead of the first — the first
  is whatever the client itself claimed and is trivially spoofable to
  defeat every IP-keyed rate limit in the app.
- `requireStaff()` now rate-limits by IP *before* verifying the JWT, so
  flooding a staff-gated route (attachment downloads included) with garbage
  bearer tokens no longer gets zero throttling.
- `clientAttachmentGet` has its own rate-limit bucket, separate from
  `clientTicketsList`/`clientTicketGet` — viewing one ticket's images no
  longer draws down the same budget a different client behind the same
  office NAT/proxy needs just to see their own ticket list.
- The client access token comparison uses a timing-safe (hash-then-compare)
  check instead of `!==`, since it's the one real secret the whole
  client-auth model depends on (ticket IDs are guessable).

## Email notifications

A staff reply also emails the requester (from `helpdesk@jetcityit.com`, a
real shared mailbox with sign-in disabled — same setup pattern as the
crew-calendar app's shared mailboxes). Sending uses **app-only Microsoft
Graph** (`api/src/lib/graph.js`), reusing the same App Registration and its
already-admin-consented application `Mail.Send` permission — no new consent
grant, just a `MAIL_CLIENT_SECRET` app setting (the same secret value used by
the crew-calendar app's availability-reminder job).

The reply itself is saved before the email is attempted, and sending is
best-effort: a failure is logged (`EMAIL_NOTIFY_FAILED` in the Function's
logs) but never fails the reply request. The email carries the full reply
text plus a tracking-page link (see above), so the requester doesn't have
to go looking for it separately.

## Testing

- **Public**: submit a ticket with no auth → 201 with a `ticketId`. Submit
  with the hidden `website` field filled in → fake 201, nothing written.
  Hammer the endpoint > 5x/min from one IP → 429.
- **As staff** (in `STAFF_UPNS`): list tickets, open one, change status/priority/
  assignee, reply → all succeed.
- **As a signed-in but non-staff `@jetcityit.com` account**: `/api/me` returns
  `{isStaff:false}`; any `/api/tickets*` call → 403.
- **Email**: reply to a real ticket → requester gets an email from
  `helpdesk@jetcityit.com` with the reply text. Reply still succeeds (200)
  even if `MAIL_CLIENT_SECRET` is missing/wrong — check the Function's logs
  for `EMAIL_NOTIFY_FAILED` in that case.
- **Client tracking**: submit a ticket, click the link in the confirmation
  email → lands on `/track.html` already signed in, showing that ticket.
  Reply from there → status flips to Open (if it wasn't), staff gets a
  notification email, and the staff console shows the new message. Request
  a link for an email with no tickets → same generic `{ok:true}` response,
  no email sent. Try a tampered/guessed token → 403, page prompts to
  request a new link.
- **Attachments**: attach a PNG/JPEG to a new ticket, a staff reply, and a
  client reply → each shows a thumbnail in both the staff console and
  `/track.html`, clickable to view full-size. Rename a non-image file to
  `.png` and attach it → rejected (signature sniffing catches it regardless
  of the claimed type). Attach a 5+ file / oversized payload → 400 with a
  clear message, nothing written. Try fetching another ticket's attachment
  URL with a valid token for a *different* email → 404.
