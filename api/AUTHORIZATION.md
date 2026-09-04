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

## Image (and .eml) attachments

Clients and staff can both attach up to 4 images (PNG/JPEG/GIF/WEBP, 10 MB
each) plus one forwarded Outlook `.eml` file (20 MB), 20 MB combined, to a
ticket-creation, staff-reply, or client-reply request — sent as base64 in
the same JSON body (`attachments: [{fileName, dataBase64}]`), not a
separate upload call. Storage/validation lives in
`api/src/lib/attachments.js`. The public submission form's "Attach an
email" field is the .eml entry point; it feeds the same `attachments` array
as the screenshot picker rather than a separate field.

- **Never trust the client's declared type.** Every upload is classified by
  its actual file-signature bytes (`sniffImageType`), and the *sniffed* type
  is what gets stored and served — a request claiming `image/png` for
  anything else is rejected outright. `image/svg+xml` is deliberately not a
  supported type: an SVG can carry a `<script>`, making it an XSS vector the
  moment it's rendered or linked to.
- **.eml has no magic-byte signature to sniff**, unlike the image formats —
  it's just RFC 822 text, so `looksLikeEmlFile` instead checks the first 8KB
  for a recognizable header block (`From:`/`Subject:`/`Received:`/etc.
  followed by a blank line). This is a loose, not a strict RFC 822 parse —
  the real security boundary is that a `.eml` is *never* served back
  `inline`, only as a forced download (`Content-Disposition: attachment`,
  via `dispositionFor`), since its body can carry HTML/script unlike a
  sniffed image.
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

## Scheduled background jobs (SLA escalation, recurring tickets, email-in)

Three features need to run on a schedule with no user request to hang off
of: SLA breach escalation, recurring-ticket creation, and email-in reply
polling (below). All three were originally built as Azure Functions Timer
Triggers (`app.timer(...)`) — **which silently never ran**, discovered
only while testing email-in replies. Azure Static Web Apps' managed
Functions integration (what this whole `api/` folder deploys as) only
supports HTTP triggers; Timer Triggers are not invoked at all in this
hosting model. The fix, rather than standing up a separate "bring your
own Functions" Azure resource (a new billable App Service/Function App
plan just for three lightweight polls): all three now run as ordinary
HTTP endpoints under `/api/internal/*`, and a new GitHub Actions workflow
(`.github/workflows/scheduled-ticks.yml`) calls each of them every 5
minutes using GitHub's own cron runner instead of Azure's.

Nobody is signed in when a schedule fires, so these can't use
`requireStaff`'s JWT flow — and the routes can't be left open either,
since they trigger real side effects (emails, ticket creation, reopening
tickets). `requireCronSecret` (`lib/auth.js`) gates all three behind a
shared secret: one `INTERNAL_CRON_SECRET` app setting on the Static Web
App, matched against an `X-Cron-Secret` header the GitHub Actions
workflow sends from a repo secret of the same value. Neither the code nor
this doc contains the actual value — set independently in both places by
whoever has access to each.

The recurring-tickets job's own due-check (elapsed time since
`lastCreatedAt`) is what actually gates ticket creation, so being invoked
every 5 minutes instead of once a day is harmless — it just no-ops on
every tick where nothing is due yet, rather than needing its own separate
schedule.

## Email-in replies

A client can reply directly to a notification email instead of going
through `/track.html`. `api/src/functions/emailIngest.js` polls the
shared `helpdesk@jetcityit.com` Inbox via Microsoft Graph (see "Scheduled
background jobs" above for how it's actually invoked, and why it isn't a
Timer Trigger), using a persisted cursor (`receivedDateTime` of the last
message processed, stored at a reserved `CONFIG` partition row) so each
poll only looks at what's new. Requires the app registration's
already-existing app-only Graph credentials plus a `Mail.Read`
Application permission (admin-consented separately from this feature's
rollout -- `Mail.Send` alone doesn't grant read access).

**Threading a reply to its ticket**: every outbound email this app sends
already embeds `[HD-YYYYMMDD-XXXX]` in its subject, and mail clients
preserve the rest of a subject line when prefixing `Re:`/`RE:`/`Fwd:`, so
matching that bracketed id is enough to find the ticket. The message body
used is Graph's `uniqueBody` property (requested as plain text via a
`Prefer: outlook.body-content-type="text"` header) -- this is Graph's own
"just the new content, quoted history already stripped" field, far more
reliable than trying to detect "On ... wrote:" boundaries by hand.
**Text-only for now**: an attachment on an inbound email reply is not
ingested; the portal still handles that case.

**The trust boundary is the `From:` address**, same as every other
email-based support system (Zendesk, Freshdesk, etc.) -- the ingest
handler only appends a message if the sender's address matches the
ticket's own stored email. Actual spoofing resistance comes from
SPF/DKIM/DMARC enforcement on the receiving side (Microsoft 365), which
this code has no visibility into or control over; this check only ensures
a message that legitimately reached the inbox from someone *other* than
the ticket's own requester never gets attributed to them.

**A real bug caught and fixed before this shipped, not by review but while
designing it**: the shared `helpdesk@` mailbox is also where the app sends
every internal notification about itself (client-reply alerts, SLA
breach escalations, and -- critically -- the "Assigned" email for a
recurring ticket, whose synthetic requester email *is* this same shared
mailbox) — all `from: helpdesk@, to: helpdesk@`, landing right back in the
same Inbox this poller reads, often with a `[ticketId]` in their own
subject. Without an explicit guard, the poller would treat the app's own
notification emails as inbound client replies, reopening the ticket and
triggering another notification back into the same inbox -- a
self-sustaining loop. Fixed with a blanket rule at the top of
`processInboundMessage`: a message whose `From:` is the shared support
mailbox itself is never treated as a client reply, full stop.

A reply ingested this way reopens the ticket exactly like a portal reply
does (`clientTicketReply` in `clientPortal.js`) — clearing
`rating`/`resolvedAt`/`firstRespondedAt`/`escalatedAt` for the same reason
documented under "Deleting tickets" and "Satisfaction rating" below: each
answers for one specific episode of the ticket, and a reopen invalidates
them. **Exception**: a reply landing on a ticket that's been `Closed` for
more than 30 days is recorded but *not* auto-reopened — subject-line
matching has no real conversation/thread correlation to fall back on, so a
client reusing a months-old notification email with unrelated new content
would otherwise silently reopen and pollute an old, possibly-rated ticket.
The staff notification for that case is worded differently ("Reply on an
old closed ticket") and asks a human to review it rather than reading as a
routine continuation.

**Retry safety**: each poll only advances its cursor past a message once
that message has been durably handled (ingested or deliberately skipped)
— a message that throws during processing stops the batch right there, so
nothing already fetched is ever silently skipped forever just because a
later message in the same batch happened to succeed. A parallel dedup
marker (`EMAILDEDUP` partition, keyed by a hash of the Graph message id)
makes re-walking the same batch on a retry safe — an already-ingested
message is recognized and skipped rather than creating a duplicate reply,
a duplicate reopen, and a duplicate staff notification.

**Known residual risk, not fixed in code — needs an Exchange Online admin
action**: the `Mail.Read` Application permission this feature needed is
tenant-wide by nature (Microsoft Graph app-only permissions aren't scoped
to one mailbox by default), and the underlying `MAIL_CLIENT_SECRET` is
shared with the unrelated crew-calendar app's availability-reminder job.
Today the *code* only ever calls into the `helpdesk@jetcityit.com`
mailbox, but the *credential* itself, if it ever leaked, could read any
mailbox in the tenant. The standard mitigation is an Exchange Online
**Application Access Policy** scoping this app registration's Graph mail
access to just `helpdesk@jetcityit.com`:
```powershell
New-ApplicationAccessPolicy -AppId <JetCity Availability App's client id> `
  -PolicyScopeGroupId helpdesk@jetcityit.com -AccessRight RestrictAccess `
  -Description "Restrict to the help desk shared mailbox only"
```
This requires Exchange Online PowerShell (not a portal click), so it
wasn't done as part of this rollout — recommended as a follow-up hardening
step, not a blocker (the code's own behavior is unaffected either way).

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

## Asset tracking

Staff-only per-client hardware inventory (`GET/POST /api/assets`,
`PATCH/DELETE /api/assets/{id}`, all gated by `requireStaff` like every other
route in this section). Deliberately **no client-facing visibility** —
extending the client-access-token model to a new resource type isn't
justified yet for what's currently a staff/back-office feature.

- **Storage**: a separate Table Storage table, `Assets`
  (`api/src/lib/assetsTable.js`) — not a reserved partition inside `Tickets`
  — so a crafted/typo'd asset id can never collide with `Tickets`' own
  reserved partitions (`CLIENT`, `CONFIG`, `RECURRING`, `EMAILDEDUP`).
  PartitionKey is the client's email domain, lowercased (e.g.
  `acmecorp.com`) — the same domain string the staff console's ticket
  sidebar already groups by (`emailDomain()` in `staff.html`) — so listing
  one client's assets is a normal partition-scoped query.
- **Fields**: label, client domain, type (`Laptop`/`Desktop`/`Server`/
  `Printer`/`Network Equipment`/`Mobile Device`/`Other`), status
  (`Active`/`In Repair`/`Retired`/`Spare`), make, model, serial number,
  purchase date, warranty expiration, assigned user/location, notes.
- **Point lookups by id alone** (no domain known yet — e.g. a ticket
  validating an `assetId`, or the id-only PATCH/DELETE routes) do a
  cross-partition scan filtered by `RowKey` (`findAssetById`), since RowKey
  isn't this table's partition key. Same accepted "full scan, fine at this
  volume" trade-off `ticketsList` already makes on the `Tickets` table.
- **Moving an asset to a different client** (editing its domain) can't be
  done as a plain `Merge`/`Replace` — Table Storage can't change a
  partition key in place — so `assetUpdate` creates the row under the new
  partition and deletes the old one instead.
- **Ticket linkage**: an optional `assetId` on the ticket meta row
  (`tickets.js`), settable via `PATCH /api/tickets/{id}` alongside status/
  priority/category/assignee. Validated against the `Assets` table (400 if
  the id doesn't resolve to a real asset); a blank value unlinks. Recorded
  in the ticket's activity trail like any other field change. Deliberately
  **not** included in `ticketToClientJson` (`clientPortal.js`'s hand-picked
  field list) — internal linkage, not client-facing.
- **Known accepted limitation**: deleting an asset does not touch any
  ticket that references it — a linked ticket's "Linked asset" field just
  fails to match any option in the dropdown afterward (shows blank) rather
  than being actively cleared. Same spirit as this app's other
  "leftover reference to deleted data" trade-offs (e.g. attachments are
  never proactively deleted from a ticket's thread either); revisit if this
  starts causing real confusion.
- **Cross-client guard**: `PATCH /api/tickets/{id}` compares a linked
  asset's domain against the ticket's own client (derived from its email)
  before accepting the link, and the staff console's "Linked asset"
  dropdown only ever lists that ticket's own client's assets in the first
  place — a ticket can't be linked to another client's hardware.

### Bulk CSV import

`POST /api/assets/import` (staff-only) bulk-creates assets from a CSV file
parsed client-side in `staff.html` (a hand-rolled tokenizer handling quoted
fields, embedded commas/newlines, and doubled-quote escaping — the same
column headers Export CSV produces, matched case/punctuation-insensitively,
so a round-tripped export re-imports cleanly, including stripping back off
the leading `'` Export CSV adds to any value starting with `=+-@` as a
formula-injection guard). Gated by the same `rejectIfTooLarge`
Content-Length check every other body-accepting route in this app uses
(checked before `request.json()` ever parses the body), and capped at 200
rows per request. Each row is created independently, at a capped
concurrency (20 at a time via a small `settleWithConcurrency` helper, not
all 200 at once — a large import usually lands entirely in one client's
Table Storage partition) — one bad row never blocks the rest of the file,
and the response reports every row's outcome
(`created: [{index, id, label, warnings}]`, `failed: [{index, error}]`) so
staff can see exactly what happened rather than an all-or-nothing result. A
failed row's message distinguishes a validation problem (specific and not
worth retrying as-is) from a transport/storage error like a throttling
response or an id collision (flagged as safe to retry).

The frontend tracks each parsed row's real file line number (not just its
position in the filtered list of non-blank rows) so a result like "Line 8:
missing domain" always points at the actual line to fix, even when the file
has blank lines mixed in with data rows.

Row validation (`validateImportRow` in `assets.js`) is deliberately more
lenient than a single create/update: `label` and `domain` still have no
sensible default and reject that row outright (sharing the exact same
validation as a single create/update, via `validateLabelAndDomain`), but an
unrecognized `type`/`status` value defaults to `Other`/`Active` (with a
`warnings` note) rather than failing the row, and an invalid date is
dropped (also noted) rather than rejected — a spreadsheet exported from
another system won't necessarily match this app's exact vocabulary, and
rejecting a whole hardware record over one bad column would defeat the
point of a bulk-onboarding tool. Import always creates new assets; it has
no concept of updating an existing one by id, even if the file includes an
`id` column (Export CSV's own `id` column is simply ignored on import).

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
- **Assets**: add an asset under a client domain → it appears in the Assets
  view's table and in the ticket detail's "Linked asset" dropdown. Link a
  ticket to it via the dropdown, Save → the activity trail shows the asset
  name, and re-opening the ticket shows it still selected. Edit an asset's
  domain to a different client → it moves to that client's filter, not
  duplicated. Delete a linked asset → the ticket's dropdown no longer shows
  it selected (falls back to blank) rather than erroring. Try
  `PATCH /api/assets/{id}` or `DELETE /api/assets/{id}` as a signed-in but
  non-staff account → 403, same as any other staff route. Try linking a
  ticket to another client's asset (e.g. via a raw API call, since the
  dropdown itself won't offer one) → 400, not a silent success.
- **Asset CSV import**: export the Assets table to CSV, then re-import that
  same file → every row round-trips into a new asset (the `id` column is
  ignored, so this creates duplicates rather than updating anything — Import
  always creates new rows). Import a file with one row missing a domain and
  a few others fine → the good rows import, the bad one is reported by row
  number and reason, nothing partially written. Import a row with an
  unrecognized status (e.g. "Broken") → it imports as Active with a
  reported warning rather than failing the row. Import a file of 201+ rows
  → rejected before anything is written, with a clear row-count error.
