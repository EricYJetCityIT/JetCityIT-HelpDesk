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

## Assigning tickets to staff

The staff console's assignee field is a dropdown (`GET /api/staff`,
staff-only) populated from `STAFF_UPNS`, with display names resolved via
Microsoft Graph (`getUsersByUpns` in `api/src/lib/graph.js`) using the same
app-only client-credentials flow as `sendMail`. This reuses an
already-admin-consented application permission (`User.Read.All`, granted on
the shared App Registration previously for the crew-calendar app) — no new
consent grant was needed. Results are cached in memory for 30 minutes per
Function instance; if the Graph lookup fails for any reason, the dropdown
still works and just shows raw email addresses instead of names.

`PATCH /api/tickets/{id}` validates `assignee` server-side against
`STAFF_UPNS` (rejecting anything else with 400) — the dropdown only ever
offers valid entries, but the assignee value doubles as an email address at
notification time, so it's re-validated rather than trusted. When the
assignee actually changes to a different, non-blank person, that person
gets a best-effort email (`ASSIGN_NOTIFY_FAILED` logged on failure, never
fails the request) with a direct link to the ticket —
`staff.html?ticket={id}` reads that query param on load and opens the
ticket immediately instead of the list, rather than dropping the assignee
onto the console's front page.

## Deleting tickets

`DELETE /api/tickets/{id}` (staff-only, same `requireStaff` gate as everything
else in this file) permanently removes a ticket: every row in its Table
Storage partition (the meta row plus the full message thread) and every
attachment blob filed under it (`deleteAllAttachmentsForTicket` in
`api/src/lib/attachments.js`, which wipes by the ticket's blob-name prefix
rather than walking each message's attachment list). There is no soft-delete
or trash — this is a deliberate, staff-initiated, irreversible action, never
a side effect of closing or updating a ticket. The staff console requires an
explicit confirmation dialog (naming the subject and ticket id) before
calling it. The action is audit-logged (`ticket.delete`) like every other
write in this file.

It first confirms a real ticket (a meta row at RowKey `0`) exists before
deleting anything — this table also holds unrelated data under other
partition names (e.g. `CLIENT`, where `clientAccess.js` stores every
client's per-email access token), and without this check a ticketId
matching one of those would delete that data instead. Per-row deletion uses
`Promise.allSettled`, not `Promise.all`, and tolerates an individual row
already being gone (404) rather than treating it as a failure — so it can't
abort partway through and skip the attachment cleanup/audit log the way an
early-abort-on-first-error would, and a second concurrent delete of the same
ticket resolves cleanly instead of surfacing a misleading 500.

Known accepted limitation: deletion is list-then-delete, not a single atomic
transaction, so a reply landing in the brief window between the delete's row
listing and its row deletions could in principle still create a message row
that isn't covered by that delete and survives as an orphan (invisible via
the console either way, since both `ticketGet`/`ticketsList` require the
meta row, which the delete removes). Both reply endpoints (`ticketReply` and
`clientTicketReply`) now clean up their own just-created message row if the
following status/timestamp update fails — covering the common case where the
ticket disappears just after the reply started — but a full fix for the
narrower remaining race would need per-partition locking, judged
disproportionate for a tool with a handful of staff and no realistic
concurrent-delete-during-reply traffic. Revisit if that assumption changes.

The staff console's "All" filter also excludes `Closed` tickets by default
(`statusFiltered()` in `staff.html`, with a tooltip on the "All" pill noting
this) so a busy queue isn't cluttered with tickets nobody needs to act on —
they're still fully visible under the dedicated "Closed" pill, this only
changes what "All" means.

## Internal notes

`POST /api/tickets/{id}/notes` (staff-only) adds a `kind: 'note'` row to a
ticket's thread — visually distinct in the staff console (dashed amber),
staff-authored only, no attachments, and never emailed to anyone. It does
not touch `updatedAt`, so jotting a note doesn't reset a ticket's aging
indicator or make it look like the client was contacted.

Notes ride in the *same* Table Storage partition as real messages, so the
one thing that matters is that the client-facing read path never surfaces
them: `clientTicketGet` (`clientPortal.js`) explicitly keeps only
`kind === 'message'` rows, dropping `'note'` (and anything else unrecognized)
by default rather than assuming a new kind is safe to show. This is the only
client-facing endpoint that ever enumerates a ticket's rows — `clientTicketsList`
only returns ticket metadata, never messages.

## Priority auto-triage

New tickets get an automatic `priority` guess (`autoTriagePriority` in
`ticketsPublic.js`) from a small keyword list (urgent, outage, down, security
breach, etc.) in the subject/description, defaulting to `Normal` otherwise.
This is a best-effort pre-sort, not authoritative — staff can always change
it by hand, and nothing security-sensitive depends on the result.

## Satisfaction rating

`POST /api/client/tickets/{id}/rating` (`{email, token, rating: 'yes'|'no'}`)
lets a client give a 1-tap satisfaction signal from `/track.html`, using the
exact same email+token auth and ownership re-check (`normalizeEmail(meta.email)
=== normalizeEmail(email)`) as every other client route. Two things are
enforced server-side, not just hidden in the UI: `rating` must be exactly
`'yes'` or `'no'`, and the ticket's status must already be `Resolved` or
`Closed` — rating a still-open ticket isn't a meaningful signal, and without
this check a call straight to the endpoint (bypassing the UI, which only
shows the prompt for resolved/closed tickets) could still write one. A
repeat call overwrites the previous answer rather than appending, since only
the latest answer matters. The rating is visible to staff in the ticket
detail view (hover for when it was given) and in the CSV export, never
emailed to anyone.

A rating answers for one specific resolution attempt, so it's cleared
(`rating`/`ratedAt` reset to empty) whenever the ticket reopens back to
Open/Pending — either via a client's own reply (`clientTicketReply`'s
auto-reopen) or a staff-initiated status change (`ticketUpdate`). Without
this, a stale rating from a prior resolution would keep showing as
"already answered" for whatever gets resolved next, in both the client's
own prompt (`track.html`) and the staff console. Moving between Resolved
and Closed is not treated as a reopen, since that's the same resolution
just being formally closed out — the rating survives that transition.

## Email notifications

A staff reply also emails the requester (from `helpdesk@jetcityit.com`, a
real shared mailbox with sign-in disabled — same setup pattern as the
crew-calendar app's shared mailboxes). Sending uses **app-only Microsoft
Graph** (`api/src/lib/graph.js`), reusing the same App Registration and its
already-admin-consented application `Mail.Send` permission — no new consent
grant, just a `MAIL_CLIENT_SECRET` app setting (the same secret value used by
the crew-calendar app's availability-reminder job).

`ticketUpdate` (`PATCH /api/tickets/{id}`) also emails the client whenever
`status` actually changes to a new value, not just on a reply — previously a
bare status change with no reply text notified nobody. This only fires from
the staff-initiated update path; a client reopening their own ticket via
`clientTicketReply` doesn't loop back through here, so they don't get a
redundant "status changed to Open" email for something they just did
themselves.

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
- **Assignment**: open a ticket, pick a name from the Assignee dropdown,
  Save → that person gets an emailed link that opens straight to the ticket
  when clicked. Re-saving with the same assignee unchanged → no email (only
  an actual change triggers one). "Assign to me" → sets the dropdown to
  your own UPN, not your display name. A staff member who's never signed
  into the console yet still appears in the dropdown, just labeled by email
  instead of name.
- **Deletion**: close a ticket → it drops out of the "All" filter but still
  shows under "Closed". Open a ticket and click "Delete ticket" → a
  confirmation dialog names the subject and ticket id; cancel it → nothing
  happens. Confirm it → the ticket disappears from every filter/domain view,
  and re-fetching `GET /api/tickets/{id}` for that id now 404s. Attach an
  image to a ticket before deleting it → its blob is gone from storage
  afterward too (not just unreachable). `DELETE /api/tickets/CLIENT` (or any
  other non-ticket partition name in the table) → 404, not a wipe of that
  partition's data. Open a ticket, let its load fail (e.g. throttle the
  network), then click "Delete ticket" → the button is disabled and the
  header is blank rather than showing a stale previous ticket's name.
