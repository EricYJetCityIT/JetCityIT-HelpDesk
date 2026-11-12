# API Authorization

## Access model

| Capability | Who |
|---|---|
| **Submit** a ticket (`POST /api/tickets`) | Anyone — no sign-in. Rate-limited by IP (5/min) plus a honeypot field. |
| **View / list / update tickets, reply (staff console)** | Only accounts on the staff allowlist: `STAFF_UPNS` **plus** anyone added on the console's Access tab (see below) |
| **Manage who is staff (Access tab)** | Only people who are staff through `STAFF_UPNS` (Azure) — optionally narrowed by `ACCESS_ADMIN_UPNS` |
| **View / reply to own tickets (client tracking page)** | Anyone holding a valid per-email access token — see below |

There is no intermediate "read-only staff" tier — being on the staff allowlist
is the entire access boundary for everything under `/api/tickets*` besides
ticket creation. Enforcement is server-side (in the Functions); the frontend
hiding the console for non-staff is a convenience, not the security boundary.

## Who is "staff"?

Same quick-start pattern as the crew-calendar app's `EDITOR_UPNS`: a
comma-separated allowlist app setting, checked against the signed-in user's
UPN (email). No app-registration change needed to add or remove someone.

```
STAFF_UPNS = dylanm@jetcityit.com,ericy@jetcityit.com,alex@jetcityit.com,simone@jetcityit.com
```

To add or remove staff in Azure: Static Web App (`jetcityit-helpdesk`) →
**Environment variables** → edit `STAFF_UPNS` → Apply. Takes effect on the next
request, no redeploy.

### Access tab (adding staff from the console)

Staff who are set in Azure can also add and remove people from the console's
**Access** tab (`staff.html`, `api/src/functions/access.js`,
`api/src/lib/staffAccess.js`) instead of editing the Azure setting. **The site
never writes Azure settings** (that would need an Azure role granted to the
Function app, a much bigger privilege than this feature warrants); it keeps its
own list and merges the two at sign-in, same model as the crew site's Access tab:

- **Where the list lives.** One row per person under a reserved `ACCESS`
  partition of the `Tickets` table (`kind: 'access'`, RowKey = lowercased UPN,
  never `'0'`). Like `CLIENT`/`CONFIG`/`RECURRING`, it never appears in
  `ticketsList` (`kind==='meta'` only) and every ticket route refuses a
  partition with no real meta row.
- **Effective staff = `STAFF_UPNS` ∪ the page-added list.** `requireStaff`
  accepts either; `getStaffUpns()` (the merged list) is what the assignee
  dropdown and its validation (`tickets.js`, `recurring.js`), round-robin
  auto-assignment (`ticketCreation.js`) and the staff broadcast emails use, so
  an added person is a full team member, not just someone who can sign in.
  Removing someone on the page never removes anyone still in `STAFF_UPNS`; those
  rows show a locked "Azure" badge and the API refuses to remove them.
- **Who can manage it.** Only people who are staff through **Azure**
  (`isAccessAdmin` in `requireStaff`, enforced by `requireAccessAdmin` on every
  `/api/access*` route). Someone added from the page can use the console but can
  **never** add or remove anyone, so access can't be passed along from a
  granted account. Optional `ACCESS_ADMIN_UPNS` (comma-separated) narrows it
  further to the people listed (who must also be in `STAFF_UPNS`); unset or
  blank means every Azure staff member, matching how the crew site behaves.
  **A value that is set but unusable (just `,`, or a typo'd list) means nobody
  can manage access**, never everybody: it fails closed, and the fix is in Azure.
- **What may be added.** Only `@jetcityit.com` addresses, and only a person
  who **exists and is enabled in the company directory right now** (Graph
  `GET /users/{upn}`, the already-consented `User.Read.All`): granting an
  address that doesn't exist yet would hand it to whoever is later issued it.
  The directory's canonical sign-in name, not what was typed, is what's stored
  and later matched against the token's `preferred_username`. If the directory
  can't be reached the add is refused (503), never allowed unchecked.
- **A grant belongs to an account, not an address.** The row also stores the
  account's Entra object id (`oid`), and `requireStaff` denies a page-added
  person whose token carries a *different* `oid` (the person left and the
  address was later reissued, or a rename freed it, so the new holder would
  otherwise inherit console access). A token with no `oid` claim can't be
  checked and is let through; every normal user token has one, so this only
  ever denies a proven mismatch. The Azure `STAFF_UPNS` list is address-only,
  as it always was.
- **Freshness.** The page-added list is cached per server instance for 30 s
  (shared in-flight read, 2.5 s timeout, last good copy kept up to 10 minutes if
  reads fail), so a change reaches every instance within ~30 s. After an add or
  remove, the instance that handled it re-reads the list; if that re-read fails
  the change is applied to the copy it already had (and that copy is marked due
  for a re-read), and overlapping changes can't overwrite each other with an
  older snapshot. If the list can't be read and nothing is cached, someone who
  isn't in Azure's list gets a 503 "try again" (and a plain 503 on `/api/*`
  instead of the usual 403) rather than a 403 that would tell a genuinely-added
  person they have no access; Azure-listed people never depend on that read.
- **Audit.** `access.add` / `access.remove` (actor + target UPN only) are
  logged, and only when something really changed; an admin-only route reached
  by someone who isn't an admin logs `access.denied`. Each added person also
  shows who added them and when on the tab.
- **Removing.** A page-added row can always be removed, even if the person was
  later also added in Azure (so dropping them from Azure afterwards really does
  revoke); an Azure-only person can only be changed in Azure. Removing someone
  doesn't unassign tickets already assigned to them: the ticket's assignee
  dropdown keeps showing them ("no longer on the staff list") so a save doesn't
  silently clear it, and the assignee is only re-validated when it actually
  *changes* (an unrelated status edit on a ticket assigned to a removed person
  still saves).
- **Picker.** The "Name or email" box only acts on an unambiguous answer: an
  address (typed, or the `Name <email>` a list choice fills in), or a name that
  matches exactly one person in full. A partial name suggests the likely match
  instead of adding anyone.
- **Not covered:** the page can't reach Azure itself, so it can't remove an
  Azure-listed person, and it adds nobody to the Azure setting. Reminder and
  escalation emails (`slaEscalation.js`) still go to a ticket's stored
  assignee, so a removed person keeps getting those for tickets still assigned
  to them until someone reassigns.

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

## Team Portal (`/team.html`, `api/org/*`) — shared, domain-scoped client accounts

A second, separate client-facing auth model, for a client organization
that wants several of their own people to see and reply to tickets filed
by *anyone* on their team, not just the person who filed each one (e.g. so
someone's out-of-office doesn't block a ticket from getting a reply). This
is materially different from the individual tracking portal above — that
model is deliberately per-email and passwordless; this one needs real,
independent, revocable identities that all share one visibility scope, so
it introduces this app's first real password-based accounts.

**Opt-in, staff-controlled, per client domain.** A client's domain (e.g.
`fredhutch.org`) has no team-portal access at all until a staff member
explicitly enables it (`POST /api/org/admin/domains/{domain}`, staff-only,
`staff.html`'s new "Team Portal" nav view). Nothing about a ticket ever
being submitted from a domain enables this automatically — it's a
deliberate expansion of what a client can see (an entire team's ticket
history, not one person's), so it warrants an explicit decision per
client, unlike the individual portal's magic-link access (which only ever
grants access to the tickets tied to the specific email that was
verified).

**Accounts, not links.** Each person signs up for their own account
(`POST /api/org/signup`: name, email, password) — the email's domain must
already be enabled, and a persistent password is genuinely necessary here
(unlike the individual portal, where a rotating magic link is enough,
since there's only ever one person to authenticate). The password is
salted and hashed with Node's built-in `scrypt` (`api/src/lib/orgUsers.js`)
— never stored or compared in plain text, and no new npm dependency was
needed for this (this environment can't run `npm install` locally to
verify a new package before pushing, so `crypto.scrypt` was preferred over
adding e.g. `bcrypt`).

**Email verification is still the real security boundary**, same
philosophy as the rest of this app's client-facing auth: a fresh account
starts unverified, and a verification link (proof of inbox ownership, not
returned directly by the signup response) has to be clicked before the
account can sign in — this is what actually confirms whoever signed up
controls that `@clientdomain` address, the same role the magic link
itself plays for the individual portal.

**Sign-in issues a session token** (`POST /api/org/login` → `{name,
domain, sessionToken}`), a random server-generated bearer secret stored
plain and compared via a hash-both-sides-then-`timingSafeEqual` check
(`api/src/lib/tokens.js`, shared with the individual portal's own access
token in `clientAccess.js`) — appropriate for a random, single-purpose
token, unlike a real password. `POST /api/org/logout` clears it,
invalidating that device's session immediately. The login check also runs
the SAME password verification cost whether or not the email is actually
registered (`DUMMY_PASSWORD_HASH`), so a nonexistent email can't be
distinguished from a wrong password by response timing.

**The session credential always travels as headers** (`X-Org-Email`,
`X-Org-Session`), never a query string, URL, or `<img src>` — unlike the
individual portal's per-email token (which only ever unlocks one person's
own tickets, so a leaked link is low-value), a team-portal session grants
an entire organization's ticket history and lets its holder post replies
attributed to that specific named teammate, so it deliberately never ends
up anywhere it could persist outside the request (browser history,
address-bar autocomplete, proxy/access logs). Attachment images are
fetched via `orgFetchBlob` + a `blob:` object URL (`team.html`, mirroring
`staff.html`'s own bearer-token-authed `apiFetchBlob` pattern) rather than
a plain `<img src>`, since a plain tag can't carry a custom header.

**Sessions expire after 30 days** (`SESSION_MAX_AGE_MS` in
`orgUsers.js`) even without an explicit logout — a deliberately shorter
leash than the individual portal's magic link (which never expires), given
how much more a team-portal session actually grants access to.

**Staff can revoke one account without touching the rest of the team**,
two different ways depending on whether it should be reversible:
- `DELETE /api/org/admin/domains/{domain}/accounts/{email}` ("Remove")
  deletes a single account outright — invalidating its password and
  session token in one step. Irreversible; they'd need a brand-new
  sign-up (and re-verification) to get back in.
- `POST /api/org/admin/domains/{domain}/accounts/{email}` with
  `{disabled: true|false}` ("Disable"/"Enable") is the reversible
  alternative — the account, password, and history are left intact, just
  blocked from signing in (and kicked out of any already-open session
  immediately, since `requireOrgSession` checks `disabled` on every
  request, not just at login). Re-enabling needs no re-signup.

Both are separate from `setDomainEnabled`, which acts on an entire client
domain at once rather than one person. All four account-level actions
(delete, disable/enable, reset-password, resend-verification — below)
share one `resolveAccountAction` helper (`orgAdmin.js`) that validates the
URL, confirms the account actually belongs to the named domain, and
applies a per-account rate limit (10/hour) — the same protection every
anonymous org/* endpoint already has via a per-IP + per-email
`checkRateLimit` pair, extended here so a compromised staff session (or a
careless script looping over accounts) can't hammer one target account
through the admin surface either. The admin view also offers "Disable
selected"/"Remove selected" bulk actions across several checked accounts
at once — these loop the same two single-account endpoints via
`Promise.allSettled` rather than a new bulk API, so one bad email in a
batch doesn't block the rest.

**Staff can resend the signup verification email**
(`POST /api/org/admin/domains/{domain}/accounts/{email}/resend-verification`,
shown only next to unverified accounts) for someone whose original link
expired or got lost, without waiting on them to find the self-service
"Didn't get a verification email?" link themselves. 400s if the account is
already verified.

**The admin view also surfaces, per domain:** an optional staff-only
`note` (up to 300 characters, stamped with who wrote it and when,
separately from the domain's own enabled-toggle audit fields so editing a
note can never be confused with changing access) — settable via
`POST /api/org/admin/domains/{domain}` alongside or independently of
`enabled` (a note-only save omits `enabled` entirely; the server looks up
the domain's *current* value itself rather than trusting a value the
client might resend from a stale page load, closing a real bug caught by
this phase's review: three of six review angles independently found that
sending a stale `enabled` value alongside a note could silently flip a
domain's access as a side effect of an unrelated edit); and per account, a
`lastSignInAt` timestamp (distinct from the shorter-lived
`sessionIssuedAt` — this one persists across disable/reset/logout, so it
keeps meaning "the last time this person actually signed in" even after
the current session is invalidated) and a `resetRequestedAt` flag (shown
as a "⚠ reset requested" badge), set when the self-service
"Forgot your password?" flow below actually finds and files a ticket for
a real account, and cleared when: staff send a reset email that actually
sends (not merely attempted — `sendPasswordResetEmail` now returns
whether the send succeeded, so a silent mail-outage doesn't make the flag
vanish while the person is still locked out); the account signs in again
on its own; the account completes a reset; or staff disable the account
(a disabled account can't sign in regardless of whether a reset is
pending, so the flag stops being actionable).

**Staff can also trigger a password reset for one account**
(`POST /api/org/admin/domains/{domain}/accounts/{email}/reset-password`,
a "Reset password" button) — emails the account holder a link
(`api/src/lib/orgEmails.js`'s `sendPasswordResetEmail`, the same "prove
inbox ownership" pattern as signup verification) to
`POST /api/org/reset-password` with a new password of their own choosing.
Consuming the link also clears any existing session, forcing
re-authentication with the new password everywhere; it's also rejected
outright (403) for a disabled account, same as login, so "Disable" reads
as a full freeze rather than just blocking sign-in.

**A locked-out user can also self-serve the first step**, via a "Forgot
your password?" link on the sign-in form
(`POST /api/org/request-password-reset`, `email` only). Rather than
emailing a reset link directly, it files a real ticket on the requester's
behalf — reusing `api/src/lib/ticketCreation.js`'s `createTicket` (the
same shared ticket-creation path `ticketsCreate` and this endpoint both
call, factored out so both get identical auto-assignment, staff
notification, and requester confirmation-email behavior) — which both
puts a visible, trackable record in the normal queue and notifies a
technician via the same auto-assignment email a public ticket triggers.
It's always filed at High priority (an account lockout is inherently
time-sensitive in a way `createTicket`'s own keyword-based auto-triage
can't infer from generated text), and the client-visible message is
written in the requester's own voice ("I'm unable to sign in...");
the "use the Reset password button" fulfillment instruction goes on a
separate internal activity-log entry instead (`recordActivity`,
staff-only, never returned by `orgTicketGet`/`orgTicketsList`), so the one
message a requester eventually sees isn't staff narration about them.
The technician then fulfills it with the existing "Reset password" button
above; this endpoint never issues a reset token or email itself. Same
generic `{ok:true}` response and a tight per-email rate limit (3/hour,
`org-reqreset-email:`) regardless of whether the email matches a real
account, for the same enumeration- and spam-avoidance reasons as
`orgResendVerification` — a ticket is only actually created when
`getAccount` finds a real account for that email, the account isn't
disabled, and its domain is still enabled (the same two checks
`requireOrgSession`/`orgLogin` apply, extended to cover this self-service
entry point too).

**Ticket visibility is scoped by domain, not by individual account.**
`GET /api/org/tickets`, `GET /api/org/tickets/{id}`, and
`POST /api/org/tickets/{id}/replies` all check the *ticket's* requester
email domain against the *session's* domain (`findTicketsByDomain` in
`clientAccess.js`, alongside its existing `findTicketsByEmail`) — every
verified account on an enabled domain sees the exact same ticket set.
Disabling a domain (`POST .../domains/{domain}` with `enabled:false`)
immediately blocks sign-in and every session check for every account on
it, without deleting any account — re-enabling needs no re-signup.

Replies are attributed to the real signed-in person's name (`authorName`),
not a generic "you" — since more than one teammate can post into the same
thread, unlike the individual portal where there's only ever one person on
the other end.

**A teammate can also rate a resolved ticket** (`POST /api/org/tickets/{id}/rating`,
`{rating: 'yes'|'no'}`) — shares the individual client portal's
`clientTicketRating` fetch/status-gate/merge core via a new
`applyTicketRating` helper (`api/src/lib/tables.js`), supplying only its
own ownership predicate (a domain match here, not an email+token pair)
and its own audit action. Same 400 if the ticket isn't Resolved/Closed
yet, same "overwrite, not append" semantics so changing your mind just
replaces the answer.

Any teammate on the domain can rate any of the team's tickets — a
deliberate extension of the shared reply/view model already used
everywhere else on this surface (any teammate can already reply to, or
view attachments on, any ticket the team filed), not an oversight: these
are internal IT tickets a team resolves together, not a public CSAT
survey, so team consensus is treated as an acceptable substitute for
exactly one person's opinion. Unlike a reply (already attributed via
`authorName`), a rating with no attribution would let one teammate
silently overwrite another's answer with no record of who or that it
changed — so the rating also stores `ratedByEmail`/`ratedByName`
(`extraFields` on `applyTicketRating`), shown alongside the rating in
both the org portal and the staff console. A reply already clears a
stale rating (and now its attribution) on reopen, in all three places a
reopen can happen (`orgTicketReply`, `clientTicketReply`, staff's own
`ticketUpdate`), so this never shows a rating — or a name — that no
longer reflects the ticket's current state.

`GET /api/org/tickets` also now returns each ticket's `requesterEmail`
(alongside the existing `requesterName`) so the frontend can offer a "My
tickets" filter without a second round trip — no new exposure, since
every teammate can already see who filed each ticket. The filter's active
state is reflected in the "Export CSV" button's own label and the
downloaded filename (`org-tickets-mine-...` vs `org-tickets-all-...`), so
an export taken while filtered can't be mistaken later for the whole
domain's history. Both the filter and export controls are disabled
whenever the ticket list isn't in a known-fresh state (a fetch in flight,
a failed non-auth fetch, or immediately after sign-out) — otherwise a
stray click could repaint a stale or even a different, previously
signed-in organization's cached ticket data on a shared workstation.

**A signed-in org account can also see a read-only view of their own
hardware inventory** (`GET /api/org/assets`, the "🖥️ Assets" button on the
ticket list) — the same domain-partitioned `Assets` table staff.html's
asset tracking already writes to, scoped to `session.domain` the same way
`GET /api/org/tickets` scopes to it. Deliberately excludes the asset's
`notes` field: that's staff-internal commentary (repair history, internal
observations) never meant to reach the client it's about, the same
"staff-only" boundary this app already draws around a ticket's `kind:
'note'` rows. There is no write path here — staff remain the only ones
who can create, edit, move, or delete an asset record; the org portal
only ever reads. staff.html's Notes field is now explicitly labeled
"internal only — never shown to the client" so a tech can't reasonably
assume a note they write there will reach the client (the schema has no
separate client-visible-note field to write one instead).

**Known gaps, accepted for now**: `assignedTo` is a freeform 200-char
field ("Person or location"), not a controlled vocabulary, and IS shown
to the client verbatim — unlike `notes`, there's no staff-only boundary
around it, so it relies on staff using it for what its label says rather
than as a second notes field. And the Assets view is read-only with no
"report an issue with this asset" link into ticket creation — a client
who spots something wrong has to file an unrelated new ticket with no
asset context attached. Both are flagged as possible fast-follows,
deliberately left out of this pass to keep it scoped to what was
actually asked for (visibility, not a feedback loop).

**Signup always returns the same generic `{ok:true}`** regardless of
whether the email is brand new, already has an unverified account (which
just resends the verification email), or already has a verified one —
matching the enumeration-avoidance `orgLogin` and
`orgResendVerification` already use, so this endpoint can't be used to
learn which coworkers at an enabled domain have already signed up.

**Known gaps, accepted for now**: no permanent brute-force lockout beyond the existing
per-IP/per-email rate limiting (an in-memory fixed-window counter, same as
every other rate limit in this app — a determined attacker could still
grind through guesses across many windows over time, just slowly).

**A signed-in org account can also file a brand-new ticket**
(`POST /api/org/tickets`, `{subject, description, category?, attachments?}`)
— not just view/reply to ones that already exist. Reuses the same
`createTicket` path (and therefore the same auto-assignment and staff
notification email) as the public form and `request-password-reset`, but
with `notifyRequester: false` — unlike those two callers, this requester
is already signed into a live view of the exact ticket they just filed, so
the usual confirmation + individual tracking-link email would be
redundant (and would otherwise mint that requester a separate, weaker
per-person credential they never asked for). `name`/`email`/`company`
always come from the authenticated session (never the request body), so
there's no way to file a ticket as someone else, and a
`recordActivity` note ("Filed via Organization Portal by {name}
({domain})") is added so staff can tell it apart from an anonymous public
submission from the ticket itself. `requireOrgSession` is the entire
authorization check — no honeypot or IP-only anti-abuse needed the way
the anonymous public form needs, since a valid session already proves
this is a verified person at a currently-enabled domain. Rate-limited the
same as `orgTicketReply` (10/min per IP, since both are
session-authenticated writes with attachments). `company` is set to the
raw domain (e.g. `fredhutch.org`), same as everywhere else in this app
that identifies a client by domain (Assets, the admin view) — a known,
accepted cosmetic mismatch against the public form's free-text company
field for the same real-world client.

**The new-ticket form also accepts an attached .eml**, matching the
public submission form's own "Attach an email" feature exactly (same
client-side parser, copied rather than shared since this app has no
build step/JS module system — see the note on this pattern elsewhere in
this doc). Reads the forwarded email client-side only to pre-fill
subject/description/category (never overwriting a field the signed-in
person already typed into), extracts up to 4 embedded images into the
same attachment list as anything manually picked, and uploads the .eml
itself as a 5th attachment on submit — `storeAttachments` already accepts
this generically (up to 4 images + 1 forwarded email per message, 20 MB
cap on the .eml, sniffed as `message/rfc822` by its actual bytes), so
this needed zero backend changes.

**Known limitation, inherited from the public form's identical feature,
not introduced by this port**: the advertised per-file hints ("4 images,
10 MB each" / "an .eml, up to 20 MB") read as independent budgets, but
`MAX_TOTAL_BYTES_PER_MESSAGE` (20 MB combined raw bytes) is checked only
server-side and is smaller than the sum of the per-file caps — a large
.eml near its own limit leaves little headroom for images, and an
.eml's own embedded images count twice toward that total (once inside
the .eml's raw bytes, once as their own extracted attachments). This is
exactly how index.html's original feature already behaves; fixing it
would mean changing both forms in lockstep, which is out of scope for a
"make it match" port.

**Adversarial security review** (high effort, 10 findings confirmed and
fixed before this shipped): the domain-move-style duplicate-row class of
bug doesn't apply here (no equivalent operation), but review did catch —
the missing per-account revocation and query-string credential exposure
described above; a signup response that leaked account existence/
verification status through distinguishable HTTP responses (now unified);
a missing `isValidDomain` check that let a malformed email's domain reach
Table Storage as a raw partition key (`getAccount` in `orgUsers.js` now
guards every caller against this); a signup race condition where two
concurrent requests for the same new email could 500 instead of resolving
cleanly; redundant sequential Table Storage reads on every session check
(now run concurrently); a dead `try/catch` and an unused export
(simplification); and `safeTokenEqual`/token generation being defined
twice across the individual and team portals (consolidated into
`api/src/lib/tokens.js`).

## Image (and .eml) attachments

Clients and staff can both attach up to 4 images (PNG/JPEG/GIF/WEBP, 10 MB
each) plus one forwarded Outlook `.eml` file (20 MB), 20 MB combined, to a
ticket-creation, staff-reply, or client-reply request — sent as base64 in
the same JSON body (`attachments: [{fileName, dataBase64}]`), not a
separate upload call. Storage/validation lives in
`api/src/lib/attachments.js`. The public submission form's "Attach an
email" field is the .eml entry point; it feeds the same `attachments` array
as the screenshot picker rather than a separate field.

A client reply (individual portal and Organization Portal) needs reply text
**or** at least one attachment: pictures alone are a valid reply, and a
reply with neither is a 400. The reply forms mirror this and say so inline
("Type a message or attach an image before sending") instead of the button
silently doing nothing, and they also report *why* a picked file was left
out (wrong type, over 10 MB, over the 4-file/20 MB caps) rather than
dropping it from the picker without a word. Staff notification emails note
how many images came with a reply (`replyBodyHtml` in `lib/html.js`), since
the text alone no longer says whether any did. Emailed replies can carry
pictures too -- see "Email-in replies" below.

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
staff-only) populated from the whole staff team (`STAFF_UPNS` plus anyone added
on the Access tab, see "Who is staff?" above), with display names for the
Azure-listed people resolved via
Microsoft Graph (`getUsersByUpns` in `api/src/lib/graph.js`; people added on
the Access tab carry the name they were added with) using the same
app-only client-credentials flow as `sendMail`. This reuses an
already-admin-consented application permission (`User.Read.All`, granted on
the shared App Registration previously for the crew-calendar app) — no new
consent grant was needed. Results are cached in memory for 30 minutes per
Function instance; if the Graph lookup fails for any reason, the dropdown
still works and just shows raw email addresses instead of names.

`PATCH /api/tickets/{id}` validates `assignee` server-side against
the staff team (rejecting anything else with 400, but only when the assignee is
actually changing) — the dropdown only ever
offers valid entries, but the assignee value doubles as an email address at
notification time, so it's re-validated rather than trusted. When the
assignee actually changes to a different, non-blank person, that person
gets a best-effort email (`ASSIGN_NOTIFY_FAILED` logged on failure, never
fails the request) with a direct link to the ticket —
`staff.html?ticket={id}` reads that query param on load and opens the
ticket immediately instead of the list, rather than dropping the assignee
onto the console's front page.

## Scheduled background jobs (SLA escalation, recurring tickets, email-in, auto-close)

Three features originally needed to run on a schedule with no user request
to hang off of: SLA breach escalation, recurring-ticket creation, and
email-in reply polling (below); auto-close of resolved tickets was added
later as a fourth, on the same mechanism (see its own paragraph below).
The first three were originally built as Azure Functions Timer
Triggers (`app.timer(...)`) — **which silently never ran**, discovered
only while testing email-in replies. Azure Static Web Apps' managed
Functions integration (what this whole `api/` folder deploys as) only
supports HTTP triggers; Timer Triggers are not invoked at all in this
hosting model. The fix, rather than standing up a separate "bring your
own Functions" Azure resource (a new billable App Service/Function App
plan just for three lightweight polls): all three now run as ordinary
HTTP endpoints under `/api/internal/*`, and a new GitHub Actions workflow
(`.github/workflows/scheduled-ticks.yml`) was meant to call each of them every
5 minutes using GitHub's own cron runner instead of Azure's.

**That cron turned out not to run every 5 minutes.** Measured from the
repository's Actions history over 12 days (60 runs), it fired about every
5 hours (median 305 minutes, between 2 and 10 hours), so emailed replies, SLA
escalations and recurring tickets were all hours late with nothing saying so
(GitHub documents scheduled runs as best-effort and delayed under load; there
is no setting on our side that fixes it). So the reliable trigger is now an
**Azure Logic App** that calls all four endpoints every 5 minutes
(`infra/scheduler-logicapp.json`, deploy steps in `infra/README.md`, about $1 a
month, the cron secret held as a secure parameter). The GitHub workflow stays as
a slow backstop and a manual "Run workflow" button. Two things in the app make
that arrangement safe and observable regardless of who calls:
- **A lease per job** (`lib/tickLease.js`). Each tick takes a lease row
  (`CONFIG` partition, RowKey `tick-<job>`, conditional on the row's ETag) for
  up to 5 minutes and releases it when done; a caller that arrives while it is
  held gets `{ ok: true, skipped: true }` and does nothing. Without it two
  overlapping callers could post an emailed reply twice, create a recurring
  ticket twice or send an SLA escalation twice. A run that is killed simply
  lets its lease expire, so a crash can't stop a job for good. If the lease row
  itself can't be read or written the tick fails (500) rather than running
  unprotected.
- **A heartbeat** in the same row (`lastStartedAt`, `lastFinishedAt`,
  `lastResult`, `lastError`), shown by `GET /api/jobs-status` as the staff
  console's "Jobs" indicator: green when every job finished a run in the last
  30 minutes, amber when one is delayed, has never finished a run, or last
  reported problems, red when one threw an error. `lastResult` is `ok`,
  `warn` or `error`: these jobs deliberately swallow per-item failures (one
  SLA email that can't be sent, one emailed reply that keeps failing and holds
  the cursor), so a job reports those by returning `problems`/`problem`,
  recorded as `warn` -- otherwise the indicator would say "OK" while the
  mailbox is stuck. Only a *finished* run counts as the job having run, so a
  job that keeps starting and never finishing can't look fresh. The console
  polls it every 5 minutes with a silent token request only (never the
  redirect-to-sign-in path), and stops polling if the sign-in has lapsed. It
  is read-only and carries no ticket data, so any staff member may read it.
- **Alerting.** The indicator only helps while someone has the console open, so
  the Logic App template can also create an Azure Monitor alert that emails when
  its runs fail (a wrong secret makes every run fail with 401, and writes no
  heartbeat at all because the secret is checked first). It is optional: see
  `infra/README.md`.

Nobody is signed in when a schedule fires, so these can't use
`requireStaff`'s JWT flow — and the routes can't be left open either,
since they trigger real side effects (emails, ticket creation, reopening
tickets). `requireCronSecret` (`lib/auth.js`) gates every one of them behind a
shared secret: one `INTERNAL_CRON_SECRET` app setting on the Static Web
App, matched against an `X-Cron-Secret` header each scheduler (the Logic
App, and the GitHub Actions workflow from a repo secret) sends with the
same value. Neither the code nor this doc contains the actual value — set
independently in each place by whoever has access to it.

The recurring-tickets job's own due-check (elapsed time since
`lastCreatedAt`) is what actually gates ticket creation, so being invoked
every 5 minutes instead of once a day is harmless (and the lease above keeps
two callers from both seeing a template as due) — it just no-ops on
every tick where nothing is due yet, rather than needing its own separate
schedule.

**Auto-close** (`autoClose.js`, `POST /api/internal/auto-close-tick`) is a
fourth tick on the same schedule and secret: any ticket that has been
`Resolved` for 3 days (`AUTO_CLOSE_DAYS`) is set to `Closed`.

- **The 3-day clock** runs from the *later* of `resolvedAt` and
  `updatedAt`, not `resolvedAt` alone. `resolvedAt` is only set the first
  time a ticket reaches a terminal state, so a ticket staff move back from
  Closed to Resolved keeps its old `resolvedAt` and would otherwise be
  re-closed on the very next tick. Any staff edit or reply bumps
  `updatedAt`, so touching a Resolved ticket restarts the 3 days; it also
  covers old tickets resolved before `resolvedAt` was tracked. A ticket
  with neither timestamp parseable is skipped, not closed on no evidence.
- **Client replies** reopen a Resolved ticket to `Open` (individual
  portal, Organization Portal, and email-in all do this), so a ticket
  still in `Resolved` has had no client *reply* since. A 👎 rating does
  not reopen, so it is checked explicitly: `rating === 'no'` tickets are
  skipped and stay `Resolved` (closing them would drop them out of the
  staff console's default view, which hides `Closed`, and bury the one
  ticket someone should look at).
- **Silent.** No email to the client (they were already told it was
  resolved) and no staff broadcast. The only trace is an activity-trail
  entry ("Auto-closed after 3 days in Resolved") and a `ticket.autoClose`
  audit line. Resolved → Closed is not a reopen, so the rating and
  `resolvedAt` are untouched, same as a manual close. The `updatedAt`
  bump on close is visible to clients as "Updated just now".
- **Race guard.** The write is conditional on the row's ETag from the
  scan, so a client reply that reopens the ticket between the scan and the
  write isn't overwritten back to Closed. A 412 (changed since the scan)
  or 404 (deleted mid-run) is skipped quietly; anything else logs
  `AUTO_CLOSE_FAILED`. If the SDK ever stops returning `etag` on listed
  entities the write silently becomes unconditional, so one
  `AUTO_CLOSE_NO_ETAG` line is logged per run as a trace.
- **Backlog cap.** At most 30 tickets (`MAX_PER_TICK`) close per run (an API
  request is cut off at 45 seconds, see the scheduler section); the
  rest follow on later ticks (`AUTO_CLOSE_BACKLOG` is logged when
  anything is deferred). The first run after deploy therefore closes every
  historical `Resolved` ticket already older than 3 days (not a 👎).

Known gaps, deliberately left alone: merging into a `Resolved` ticket
doesn't reopen it, so it can be auto-closed even though the merge just
added content; a staff panel left open on a ticket that then auto-closes
can Save it back to `Resolved` (and email the client the status change);
and an email reply arriving on a ticket more than 30 days past
`resolvedAt` is logged but not reopened once it is `Closed` (the existing
`emailIngest.js` stale-closed rule).

Like the other three jobs it only runs when something calls it: the Azure
Logic App (`infra/`) every ~5 minutes, or the GitHub workflow's auto-close step
as a slow backstop. `INTERNAL_CRON_SECRET` is shared by all four.

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
**Attachments on an emailed reply** (`api/src/lib/emailAttachments.js`):
picture attachments are imported onto the ticket as part of the reply, using
the same storage and byte-sniffing as a portal upload (`storeAttachments`),
so a file *claiming* to be a PNG that isn't one is rejected no matter what
the email says.
- *Which pictures.* PNG/JPG/GIF/WEBP, max 4 per email, 10 MB each and 20 MB
  combined. A regular attachment is always the sender's. An **inline** image
  (a screenshot pasted into the body) is imported only if the body text
  references its content id (`[cid:...]`) -- Outlook re-attaches earlier
  pictures from the quoted thread on a reply, and those aren't new.
- *Why the poll can't just trust `hasAttachments` (or the text).* Graph
  reports `hasAttachments` as `false` when a message's only attachments are
  inline, which is exactly a pasted screenshot, and the plain-text body shows
  an inline image as `[cid:...]` only some of the time (a client that
  generated alt text for the picture can render that instead). So the
  attachment list is read for every verified reply
  (`GET /messages/{id}/attachments`: metadata first, then one full fetch per
  candidate image, sender's own attachments before inline ones), and an
  inline image counts as referenced if its content id appears in the text
  body **or**, failing that, in the HTML body (one extra
  `GET /messages/{id}?$select=uniqueBody` with an HTML `Prefer` header,
  fetched lazily and only when an inline image needs it). The content id is
  matched on a boundary, with angle brackets tolerated, so `ii_1` can't match
  `ii_10`. The `[cid:...]` placeholders are then stripped from the stored text
  (the blank-line collapsing that goes with it only happens to text that had
  one, so ordinary replies are stored untouched). No new permission:
  `Mail.Read` already covers attachments.
- *Anything else is flagged, not silently dropped.* A PDF/Visio/Word
  attachment, an over-limit or invalid image, or a failed download is listed
  in a staff-only activity-trail entry and in both staff notification
  emails ("Not imported: ..."); the original is still in the `helpdesk@`
  mailbox. An email that is *only* un-importable attachments still becomes a
  reply (and reopens the ticket) with a one-line placeholder, rather than
  being ignored or showing as a blank message.
- *Errors are bounded so they can't wedge the poll.* A **permanent** problem
  (403 for a missing permission, 404, an invalid file) degrades immediately
  to the "not imported" note above, never an exception, so one bad attachment
  or a missing permission can't hold every later email hostage. A
  **transient** one (429/5xx/no response from Graph, or a blob-storage
  failure) is retried once in place (honoring `Retry-After`, capped at 3 s),
  and if it persists the email throws -- after deleting whatever it already
  stored -- and is retried on the next poll like any other failure here.
  That retrying is itself bounded: once an email is more than 30 minutes old
  (`ATTACHMENT_RETRY_WINDOW_MS`) it goes through as text with a "not
  imported" note instead, so a long outage can't stall the cursor, and every
  text-only reply behind it, forever. Each attachment-related Graph call has
  a 15 s timeout, and a poll stops *starting* new emails after 25 s
  (`POLL_TIME_BUDGET_MS`) -- the rest wait for the next poll, since the
  cursor only moves past what was actually handled. These numbers are sized
  to Azure Static Web Apps' documented limit of **45 seconds per API
  request** (for every API backend): the SLA escalation job is capped at 20
  tickets per run (`SLA_MAX_PER_TICK`) and auto-close at 30 for the same
  reason. A run that does go past 45 s is cut off for the *caller* (a Failed
  action in the Logic App's run history, or a failed backstop step) while
  the function may well finish; the lease (5 min) outlasts that, and the
  Jobs indicator, not the caller's status, says whether the work happened.
- *Only pictures count.* Whatever `storeAttachments` sniffs the bytes as, a
  result that isn't `image/*` (a file named `.png` that is really an Outlook
  `.eml`, which the portal forms accept on purpose) is deleted again and
  reported as not imported.
- *No overlapping polls.* The scheduled workflow now has a `concurrency`
  group, so a slow poll can't overlap the next one -- two polls that both
  saw the same email before either wrote its `EMAILDEDUP` marker would post
  the reply twice. (Importing pictures makes a poll take seconds per email
  instead of milliseconds, which is what widened that window.)
- *Known limitation: signature logos.* An Outlook signature image is an inline
  picture in the new part of the body, indistinguishable from a pasted
  screenshot without guessing, so a sender whose signature has a logo gets it
  attached to each emailed reply (and it counts toward the 4-image cap).

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

## Smartsheet linking

`staff.html`'s reply box has a "📊 Link Smartsheet" button next to the
attachment picker, on every ticket, plus three ways to commit a picked
sheet — **two fundamentally different kinds of "linked"**, not variations
on one mechanism:

- **"Save"** — adds the sheet to the ticket's own staff-only
  `linkedSheets` list (the same idea as the "Linked asset" field in the
  ticket header), shown in a persistent panel below the reply box, each
  removable with its own × at any time. This is a property OF THE TICKET,
  never part of the message thread, never emailed, never visible to the
  client anywhere (`/track.html`, the Organization Portal) — the default,
  since by default **the requester should never receive a linked sheet at
  all**.
- **"Send"** and **"Send reply"** — attach the sheet to an actual outgoing
  reply instead: a `kind: 'message'` row that IS emailed to the requester
  and IS visible in their own thread, same as an attached screenshot.
  "Send" fires immediately with no reply text required (for "the client
  asked for this sheet, hand it over now"); "Send reply" is the ordinary
  compose-a-message button and still always requires actual text.

**Auth**: a single shared Smartsheet Personal Access Token
(`SMARTSHEET_API_TOKEN` app setting) for the whole team, not per-staff OAuth
— Smartsheet's own docs recommend a PAT over OAuth for exactly this shape of
integration (one internal tool, one team, not a multi-tenant product), and
it matches this app's existing "one shared credential" pattern
(`MAIL_CLIENT_SECRET`/`graph.js`). The token authenticates as whichever
Smartsheet account it belongs to, so only sheets that account can see are
ever listed or linkable — same access boundary as that account has in
Smartsheet itself, nothing broader. Like every other credential in this
app, the token itself is generated and pasted into Azure App Settings by a
human, never handled by Claude.

- `GET /api/smartsheet/sheets` (`api/src/functions/smartsheet.js`,
  staff-gated) backs the reply box's picker — a name + a Smartsheet-issued
  `permalink` per sheet, cached 5 minutes (`api/src/lib/smartsheet.js`) to
  avoid a Smartsheet round-trip on every open of the picker. A sheet whose
  `permalink` isn't a real `https://app.smartsheet.com/...` URL is dropped
  rather than surfaced — that field is rendered as a live, clickable
  `<a href>` shown to clients too, so it's validated at the source instead
  of trusted blindly just because it came back from Smartsheet's own API.
- **Neither commit path trusts client-supplied sheet name/permalink
  text.** The frontend only ever sends bare sheet ids; both
  `ticketReply` (for Send/Send reply) and the new
  `ticketLinkedSheetAdd` (for Save) call `resolveLinkedSheets()`/
  re-resolve against `listSheets()` (`api/src/lib/smartsheet.js`),
  storing exactly what Smartsheet itself returned. Without this, a
  malicious or compromised staff-side request could attach an arbitrary
  "Linked Smartsheet" chip pointing anywhere it likes — rendered as a
  trusted-looking link in front of the client for Send/Send reply, or
  just presented to staff for Save — the same class of "never trust the
  client's declared value" reasoning already applied to attachment
  content-type sniffing above. `ticketReply` resolves its sheets *before*
  `storeAttachments()`: a cheap, side-effect-free lookup, so if Smartsheet
  is unreachable there's nothing to clean up yet — resolving it after
  attachments were already uploaded would risk orphaning those blobs with
  no cleanup path if the Smartsheet call then failed.
- An id that doesn't resolve (sheet deleted, access to it revoked from the
  shared token's account, or — since each Function instance caches the
  sheet list independently — briefly stale across instances) is silently
  dropped by `ticketReply` rather than failing the whole reply (its
  response echoes back exactly which sheets were actually linked, and
  `staff.html` warns if fewer made it in than were picked) — but is a hard
  400 for `ticketLinkedSheetAdd`, since that's a single, deliberate,
  one-sheet action with no reason to silently do nothing.
- **Two separate storage locations, matching the two separate concepts.**
  A Send/Send-reply sheet is stored as `linkedSheetsJson` on the MESSAGE
  row (parallel to `attachmentsJson`), surfaced as `linkedSheets` in
  `messageToJson`/`messageToClientJson`/`messageToOrgJson`. A Saved sheet
  is stored as `linkedSheetsJson` on the ticket's own META row instead —
  same field name, different row, staff-only — surfaced as `linkedSheets`
  in `metaToJson` but deliberately **not** added to
  `ticketToClientJson`/`ticketToOrgJson` (matching `assetId`, which
  follows the identical staff-only pattern). `ticketMerge` handles both:
  message-level sheets migrate with their row same as any attachment
  metadata; ticket-level sheets are unioned (target's own list first, then
  source's, deduped by id) into the target's own list when the source
  ticket is merged away, since that data would otherwise silently vanish
  with the deleted source meta row. Target-first means an identical sheet
  linked on both keeps the target's own copy, and the target's own sheets
  are never the ones a `MAX_TICKET_LINKED_SHEETS` (10) overflow truncates —
  if the combined count is over that cap, the drop is at least logged
  (`MERGE_LINKED_SHEETS_TRUNCATED`), matching how a failed attachment copy
  a few lines earlier in the same function is also logged rather than
  silently dropped.
- If `SMARTSHEET_API_TOKEN` isn't set (e.g. before it's configured for the
  first time), the picker, `ticketReply`, and `ticketLinkedSheetAdd` all
  surface a plain "Smartsheet is not connected yet" error rather than a raw
  failure — everything else about replying to or updating a ticket keeps
  working normally. The picker doesn't cache a failed load, so it retries
  cleanly on the next open instead of replaying the same stale error for
  the rest of the session once the token's added.
- Switching to a different ticket clears any unsent reply/note draft,
  staged image attachments, AND any staged Smartsheet pick — all four
  together, in `openTicket()`. Without this, a draft (including a live link
  to internal Smartsheet content) staged for one ticket could get sent to a
  completely different client if staff switched tickets mid-draft and then
  hit Send without noticing.
- A Saved sheet is bookkept like an internal note, not like a real reply:
  `ticketLinkedSheetAdd`/`ticketLinkedSheetRemove` bump `updatedAt` (a
  genuine staff touch on the ticket, same as changing status/category/
  assignee/asset already does) but never `firstRespondedAt` (the SLA
  "first response" clock) — only an actual Send/Send-reply, a real
  client-facing communication, stops that clock. A Save that quietly set
  `firstRespondedAt` could mask a genuine SLA breach on a ticket the client
  was never actually told anything about.
- All three reply-box buttons ("Send reply", "Send", "Save") share one
  staged draft/selection, so all three are disabled together for the whole
  submit — not just the one clicked — while any one request is in flight.
  Otherwise clicking two of them before the first resolves could act on the
  same staged sheet twice (e.g. both privately save it AND email it in the
  same moment).
- **Known, accepted limitation**: `ticketLinkedSheetAdd`/`Remove` read the
  ticket's current linked-sheets list, then write back a modified copy,
  with no optimistic-concurrency check in between — two staff editing the
  same ticket's linked sheets within the same moment could have one
  overwrite the other's change. This is the same non-atomic
  read-then-write shape `ticketUpdate` already has for every other ticket
  field (status/priority/assignee/asset), not a new gap this feature
  introduces, and not worth a bespoke fix here (ETags/If-Match) while nothing
  else in this app has one either — recoverable in practice by just
  re-adding the lost sheet.

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

## Staff team broadcast

Every staff member (every entry in `STAFF_UPNS` plus anyone added on the Access tab) gets emailed on three
events, so anyone can notice ticket activity — especially a client
follow-up sitting unanswered — without actively watching a specific
ticket or relying on whoever's assigned to flag it themselves:

1. A new ticket is submitted (public form or Organization Portal).
2. The requester replies (individual tracking portal, Organization Portal,
   or by replying directly to a notification email).
3. The ticket's **currently assigned** staff member replies — deliberately
   scoped to the assignee specifically, not any staff reply, so this
   answers "did the person this is assigned to actually respond" rather
   than just "did someone reply."

**Implementation**: `api/src/lib/staffBroadcast.js`'s `notifyStaffTeam(context, {subject, html})`
sends ONE message with every staff address (`getStaffUpns()`) in the To line (not a
separate send per person) via the same app-only `sendMail()` used
everywhere else — `graph.js`'s `sendMail` was extended to accept `to` as
either a single address or an array for this. Self-swallowing: a failure
is logged (`STAFF_BROADCAST_FAILED`) but never thrown, so this can never
block ticket creation or a reply from saving — the same "best-effort,
never block the core flow" convention every other notification email in
this app already follows, just centralized in one helper instead of a
`try/catch` repeated at each of the 5 call sites (`ticketCreation.js`'s
shared `createTicket()` — covering both the public form and the
Organization Portal for free; `clientPortal.js`'s `clientTicketReply`;
`orgPortal.js`'s `orgTicketReply`; `emailIngest.js`'s
`processInboundMessage`; and `tickets.js`'s `ticketReply`, gated on
`user.upn === meta.assignee`).

Recurring auto-created tickets (`recurringRun.js`) do NOT trigger the
new-ticket broadcast — that job builds its ticket rows directly rather
than through the shared `createTicket()` helper, and its synthetic
"requester" (the shared support mailbox itself) isn't a real client
submission in the sense this broadcast is meant to surface.

This is real-time per-event, not a digest — a busy day means a steady
trickle of these emails to every staff member, by design (the alternative
of only notifying whoever's assigned would have missed exactly the
"assignee never got to it" case this exists to catch).

**Rate-limited on the new-ticket broadcast specifically**: `createTicket()`
is reachable from the public, unauthenticated submission form, and the
per-assignee "Assigned:" email a few lines below already exists
specifically because a slow-and-steady or distributed flood can stay
under the public form's per-IP submit limit while still riding the
round-robin to spam a person repeatedly. The new-ticket broadcast is
exposed to the exact same risk — worse, it reaches the *whole team* per
event instead of one person — so it gets its own shared `checkRateLimit`
bucket (`staff-broadcast:new-ticket`, 30/hour) rather than firing
unconditionally like the reply-triggered broadcasts do (those three all
sit behind an existing per-IP or per-session request-level rate limit of
their own already).

**`excludeUpn`**: `notifyStaffTeam` accepts an optional `excludeUpn` to
drop one address from the recipient list — used only by the
assignee-reply broadcast, so a tech replying to their own assigned ticket
doesn't get an email telling them they just did that.

**Known, accepted overlap, not a bug**: a new *assigned* ticket sends the
assignee two separate emails — the pre-existing individual "Assigned:
..." and this new team-wide "New ticket: ...". Different content (one
says "this is yours," the other is a general team FYI), so both are kept
rather than suppressing one.

**Distinct from `slaEscalation.js`, not a replacement for it**: SLA
escalation is a periodic scan that flags a specific ticket once it
crosses its response-time target; this broadcast is real-time and fires
on every event regardless of timing. They're complementary, not
coordinated — an ignored ticket can trigger both a real-time broadcast
(on the original requester reply) and, later, a separate SLA-breach
email, with no cross-referencing between the two. Worth knowing they're
two independent systems rather than one replacing the other.

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

## Phone apps (installable web apps, not in any app store)

There are two apps, each just a page of this site added to the phone's home screen (the same approach
as the crew-calendar site): the **staff app** (`/staff.html`, name "HD Staff") and the **client app**
(`/track.html`, name "Help Desk"). Nothing goes through the App Store or Google Play. Each page shows a
"📱 Get the app" button on phones/tablets that haven't installed it yet; it opens a short how-to
(iPhone: Safari's Share, found under the ⋯ More button in the default compact toolbar, then Add to Home Screen; Android: one-tap Install when Chrome offers it).

Pieces: `manifest-staff.json` / `manifest-client.json` (one each, with their own `id`, `start_url` and
`scope`, so they install as two separate apps), `icons/` (generated from `logo.png` by
`tools/make-icons.ps1`; the source logo is only 237 px, so a larger one would give sharper icons),
`sw.js` (the service worker both apps share), and `app-shell.js` (registers the worker and runs the
install how-to). The SWA config sends `Cache-Control: no-cache` for `sw.js` and the manifests so an
update is never held back by a cache.

**What the service worker caches, and what it never touches.** It keeps the app's *pages and static
files* openable with no signal. It is network-first, so a fresh deploy always wins when there is a
connection; a saved copy is used only if the network fails or takes over 6 s. It never caches or
intercepts `/api/*` or any non-GET request (ticket data, attachments, anything with a token), and it
leaves cross-origin requests (Microsoft sign-in, Graph, Google Fonts) alone, so the sign-in redirect
behaves as in a normal tab. Pages are stored under their **path only**: the tracking page is opened
with `?email=…&token=…`, and a secret must not become a cache key (or pile up one copy per query).
Offline you get the page and sign-in screen, not tickets: data still needs a connection.

The cache is never allowed to break the site, because this worker sits in front of every page it
controls. Every Cache Storage call is isolated and the cache is opened alongside the request, never
before it, so a browser cache fault (a full phone, or iOS 17.0's `caches.match` "Internal error" bug
that stopped installed apps from starting when a worker didn't catch it) just means that request goes
over the network as if there were no worker. A 404 that has a saved copy shows that copy **once** and
then drops it: a brief post-deploy 404 blip heals on the next load, while a page that was really
removed can't stay pinned in the cache forever. (A 5xx is an outage, so its saved copy is kept.)

**Sign-in inside the installed app.**
- *Staff app:* the same Microsoft sign-in as the console, with MSAL's cache in `sessionStorage` just
  like the crew site, so after the app has been fully closed it signs in again (nothing is stored on the
  phone). This is the deliberately safest setting for a tool that shows client information; "stay
  signed in" would mean keeping the token in `localStorage`. Apple documents that OAuth sign-in on a
  third-party domain stays inside an installed web app (WWDC23 session 10120, which calls it a
  heuristic), so this should work, but it **has not been verified on a real iPhone** and must be tried
  on a device.
- *Client app:* the tracking link's session lives in `localStorage`. On **Android** an installed app
  shares Chrome's storage, so it just works. On **iPhone** the app has private storage and links in
  emails open in Safari, never in the app, so the app's sign-in screen has a "paste your tracking link"
  box (shown only inside the installed app): the person copies the link from their email and pastes
  it. It accepts only this site's `/track.html` link and rebuilds the address from just `email`,
  `token` and `ticket`, so it can't be used to send anyone elsewhere. A link wrapped by a mail filter
  (Microsoft Safe Links keeps the real link URL-encoded in `?url=`) is unwrapped once; what is inside
  must still be this site's `/track.html` with an email and a token.
- Install guides: `staff-app.html` (staff) and `customer-app.html` (customers) are public step-by-step pages with iPhone, Android and
  computer tabs (the tab for the device in use opens first; `#iphone`, `#android`, `#computer` in the link choose one). They link only
  to their own audience's app and say to install from the sign-in page, not the guide (adding the guide to the home screen would
  install the guide). The staff sign-in card and the tracking page header each carry a "Get the app" link to their own guide
  (`data-app-guide`, hidden inside the installed app by `app-shell.js`); the customer pages carry no staff link. The home page and the Help
  Center header also carry a "Get the app" link to the customer guide (so customers can find it without an email); it is not on the
  Organization pages, whose users have no tracking links.
- Phone alerts (push notifications) for both apps: see the next section.

## Phone alerts (push notifications)

Both installed apps can alert the phone when something happens on a ticket, with the app closed. The
button is "🔔 Turn on alerts" in each page's header (shown once someone is signed in, and only on a
browser that can do push). Tapping it asks the phone for permission, registers the device, and sends a
test alert straight away. **iPhone only allows alerts for an app that has been added to the Home Screen
and opened from there**, and needs iOS 16.4 or later; in a normal Safari tab the button explains that
instead. The permission prompt must come from a tap, so alerts are never switched on silently.

**What is alerted** (each also still sends the email it always did):
- *Staff devices:* a new ticket (everyone; an auto-assignee gets one "New ticket assigned to you" alert
  instead of two), a ticket assigned to you in the console (not when you assign it to yourself), a
  requester's reply (portal, organization portal or email), the assignee's reply (everyone else), an
  SLA breach (the assignee, or the whole team if nobody has it or the assignee is no longer staff), and a
  recurring ticket assigned to you. Same caps as the emails: the new-ticket alert rides the same
  30-per-hour team flood cap.
- *Client devices:* a staff reply, and a status change. **Not** the automatic Resolved→Closed (that is
  deliberately silent, as the email is).

**What an alert contains.** Only a title, the ticket's *subject* (clipped), the page to open and a tag,
never message text, names or addresses. It passes through the phone vendor's push service (Google,
Apple, Mozilla or Microsoft) end-to-end encrypted. The tag makes a newer alert about the same ticket
replace the older one on the lock screen. A tap opens that ticket in the already-open app, or opens
the app. The service worker (`sw.js`) checks the target again before opening it: only `/staff.html` and
`/track.html` on this site, anything else opens the home page. The client link carries no credentials:
the client app uses the sign-in already kept on that phone, and the server still shows a ticket only to
the address it belongs to.

**Storage and who can register.** One row per device in the Tickets table, `kind: 'push'` (never
`'meta'`, so it is never a ticket), under a reserved partition per audience: `PUSH-STAFF` (written only
via `requireStaff`) and `PUSH-CLIENT` (only with a valid email + tracking token). The RowKey is the
SHA-256 of the push address, so a device belongs to **one person at a time**: if a phone is handed over
and the new person turns alerts on, the row moves to them and the previous person stops receiving that
phone's alerts. Caps per person: 8 staff devices, 4 client devices (the least recently seen is dropped).
Registration routes (all `POST`, JSON, 8 KB cap, IP rate-limited): `/api/push/{subscribe,unsubscribe,test}`
(staff) and `/api/client/push/{subscribe,unsubscribe,test}` (client), plus the public
`GET /api/push/key` (the *public* half of the signing key, which a browser needs to subscribe).
Unsubscribing only works for the device's owner; "test" sends to the caller's own devices only
(5 per minute). An installed app re-sends its registration when it is opened (at most every 12 hours per
person), which keeps the server's copy current and repairs a device whose address changed or that was
registered under an older signing key. Opening the app **never** switches alerts back on for a device
the person turned off.

**Who actually receives an alert.** Staff alerts go only to people who are staff *at the moment of
sending* (the Azure list plus the Access tab, `getStaffUpns()`), so someone removed from the Access tab
stops being alerted immediately, whether or not their phone's row has been cleaned up. Removing a
person on the Access tab also deletes their devices (unless Azure still lists them). Client alerts go to the
devices registered under the ticket's own email. "Not you" on the client page switches that phone's
alerts off (using the session being forgotten) before it forgets the person.

**Request forgery protection.** This server POSTs to whatever address a device registered, so an address is
accepted only if it is `https`, on the default port, without credentials or a fragment, and on a real push
service: `fcm.googleapis.com`, `web.push.apple.com`, `updates.push.services.mozilla.com`,
`*.push.services.mozilla.com`, `*.notify.windows.com`. The same check runs again at send time. The key
material is validated too (a P-256 public key of 65 bytes and a 16-byte secret).

**The signing key (VAPID).** Generated on first use and stored in one `CONFIG` row (`vapid`), so there
is no secret to paste into Azure. The private half never leaves the server; only the public half is
served. **Deleting that row invalidates every registered device**: the apps notice the changed key the
next time they are opened and register again by themselves (people whose app stays closed get no alerts
until they open it). Do not delete it casually.

**Delivery limits.** Alerts are sent from inside the request that caused them, and Azure Static Web Apps
cuts a request at 45 s, so every send has a 4 s timeout and each event a 5 s overall deadline (and at
most 100 devices); a slow or down push service can delay a ticket page by at most a few seconds. Alerts
run *alongside* the email, not after it, and the SLA job collects its alerts and waits for them once
after its loop. A device the push service reports as gone (404/410) is deleted; any other failure leaves
the device alone (a rejected key or an outage must not wipe everyone's alerts). A staff alert that fails
never blocks the email or the action that triggered it. The `web-push` package is loaded the first time
it is needed (not at startup), so a problem with it can lose alerts but cannot stop the API from starting.

**Not done / limits.** The Organization Portal is not an app and has no alerts. A device's address
changing while the app is closed is repaired only when the app is next opened (no background re-register).
Alerts for staff are team-wide like the emails; there is no per-person "only my tickets" filter yet.
This has been tested with the push service and the Azure table stubbed; **a real alert on a real phone
(and iPhone's Home-Screen requirement) still has to be tried on a device.**

## Testing

- **Public**: submit a ticket with no auth → 201 with a `ticketId`. Submit
  with the hidden `website` field filled in → fake 201, nothing written.
  Hammer the endpoint > 5x/min from one IP → 429.
- **As staff** (in `STAFF_UPNS`, or added on the Access tab): list tickets, open
  one, change status/priority/assignee, reply → all succeed.
- **As a signed-in but non-staff `@jetcityit.com` account**: `/api/me` returns
  `{isStaff:false}`; any `/api/tickets*` call → 403 (or 503 "try again" if the
  Access tab's list couldn't be read at that moment).
- **Access tab**: as an Azure-listed staff member, add a person → they can sign
  in on their next page load and appear in the assignee dropdown; remove them →
  they lose access within ~30 s. As someone added from the page, the tab and
  every `/api/access*` call are refused (403).
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
- **Team Portal**: sign up with a domain staff hasn't enabled → 403, clear
  message. Staff enables the domain (`staff.html`'s Team Portal view) →
  the same signup now succeeds and an unverified account row exists (shown
  in that same admin view). Try signing in before verifying → 403 telling
  you to check your inbox. Click the verification link → account flips to
  verified, shown live in the admin view; signing in now works and returns
  a session. A second person signs up on the same domain, and each replies
  to a ticket the other filed → both succeed, both show up in the same
  shared ticket list, and each reply is attributed to the real person who
  wrote it. Staff disables the domain → both accounts immediately can't
  sign in (existing sessions also stop working on their next request), but
  re-enabling needs no re-signup. Try a wrong password → generic "Invalid
  email or password," not "no such account." Try requesting a new
  verification link for an email with no account → same generic
  `{ok:true}` response as a real one, no email sent. Sign up again with an
  email that's already verified → same generic `{ok:true}` as any other
  signup, not a distinguishable "already exists" error. Staff removes one
  account via the admin view's "Remove" button → that person's session
  immediately stops working and their old password no longer signs them
  in, but their teammates on the same domain are unaffected. Inspect a
  ticket detail page's network requests → the session credential appears
  only in `X-Org-Email`/`X-Org-Session` request headers, never in a URL or
  query string. Staff clicks "Disable" on one account while that person is
  signed in elsewhere → their very next request fails with "This account
  has been disabled," not just their next sign-in attempt; "Enable" lets
  them sign in again with their existing password, no re-signup needed.
  Staff clicks "Reset password" → the account holder gets an email with a
  set-new-password link; entering mismatched passwords on that page is
  caught client-side before any request is sent. Using the link signs out
  any existing session for that account and the old password stops working
  immediately. A stale/reused reset link → "Invalid or expired reset
  link," not a silent failure. Disable an account, then try its
  (still-unused) reset link → also rejected, not silently honored.
  Hammering the same account's admin actions (reset/disable/remove) more
  than 10 times in an hour → 429, independent of how many other accounts
  or domains staff are managing at the same time. Click "Forgot your
  password?" on the sign-in form for a real account's email → generic
  "we've let Jet City IT know" message either way; a new ticket shows up
  in the staff queue (category "Account Access", priority "High") auto-assigned
  to a technician, who gets the same "you've been auto-assigned" email a
  public ticket would trigger, plus an internal activity-log note pointing
  them at the "Reset password" button; the requester gets the same
  confirmation + tracking-link email as any other new ticket, and their
  own message on it reads in first person, not as staff narration about
  them. Try it for an email with no
  account, a disabled account's email, or an account on a domain staff
  have since disabled → same generic response every time, but no ticket
  is created (check the staff queue). Click it more than 3 times in
  an hour for the same email → later clicks still show the generic
  message, but stop actually filing new tickets. Sign in and click "＋ New
  ticket" → subject/description/category submit as a real ticket,
  auto-assigned and staff-notified the same as the public form, attributed
  to the signed-in person's real name/email and their organization's
  domain as "company"; it immediately shows up in the shared ticket list
  for any other teammate on the same domain, and its activity trail (staff
  console only) shows "Filed via Organization Portal by ..." — unlike the
  public form and "Forgot your password?", the requester does NOT get a
  separate confirmation/tracking-link email, since they're already looking
  at the ticket in the portal. On that same form, attach a real forwarded
  .eml → subject/description/category fill in (only for fields left
  blank), embedded screenshots join the attachment list, and the .eml
  itself is uploaded too — remove the .eml afterward and confirm only the
  images it contributed disappear, not anything picked by hand. Staff
  admin view: leave a note on a
  domain, then have a second (unrefreshed) tab try enabling/disabling that
  same domain → the toggle still only changes what that tab actually
  clicked, never silently reverted by an unrelated note save elsewhere.
  Staff click the admin view's "Resend verification" for an account, then
  click it again after they've verified → 400 "already verified," not a
  silently-resent email (this is distinct from the self-service, anonymous
  `/api/org/resend-verification` used by the sign-in page's own "Didn't
  get a verification email?" link, which always returns the same generic
  `{ok:true}` regardless of account state — that one's enumeration-safe
  generic response is unchanged). An
  account's last-sign-in timestamp updates after a fresh sign-in but
  survives a disable/re-enable cycle (unlike sessionIssuedAt, which is
  cleared by it). Rate a Resolved ticket 👍/👎 → the choice is saved,
  highlighted next time the ticket is opened, and shows who rated it; have
  a second teammate change the same ticket's rating → the name updates to
  them (only the latest answer + its rater are kept). Try rating an Open
  ticket directly via the API → 400, not silently accepted. Reply to a
  rated, Resolved ticket → it reopens, the rating card disappears, and the
  rating + rater are cleared server-side (check via the staff console that
  neither lingers). Toggle "My tickets" → only tickets whose requester
  email matches the signed-in account remain, including one filed via the
  old public form with different email casing; toggle back to "All
  tickets" to see the full shared list again. Export CSV while "My
  tickets" is active → the button reads "Export CSV (My tickets)" and the
  downloaded filename/contents reflect that filter, not the whole domain.
  Trigger a non-auth ticket-list load failure (e.g. throttle the network)
  → the filter and export buttons are disabled, not just showing an error,
  so a stray click can't repaint stale data over the error message; sign
  out and back in as a different organization on the same tab → the
  previous org's tickets never flash on screen before the new load
  completes. Click "🖥️ Assets" → the signed-in organization's own assets
  load (label/type/make/model/serial/status/assigned-to/warranty), with
  the same amber/red warranty-soon/expired highlighting staff.html uses;
  an asset's internal `notes` field never appears anywhere in the org
  portal. An organization with no assets on file sees a clean empty state,
  not an error. Confirm there's no way to create/edit/delete an asset from
  this view — it's read-only by omission, not by a hidden check.
