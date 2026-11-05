# Help Desk scheduler (Azure Logic App)

The Help Desk has four background jobs, each a plain HTTP endpoint that something has to call on a
schedule (Azure Static Web Apps can't run timers itself):

| Job | Endpoint | What it does |
|---|---|---|
| Email replies | `POST /api/internal/email-ingest-tick` | Turns emailed replies (and their pictures) into ticket replies |
| SLA escalation | `POST /api/internal/sla-escalation-tick` | Emails when a ticket passes its response-time target |
| Recurring tickets | `POST /api/internal/recurring-tickets-tick` | Creates tickets from due recurring templates |
| Auto-close | `POST /api/internal/auto-close-tick` | Closes tickets that sat in Resolved for 3 days |

They were being called by a GitHub Actions cron set to every 5 minutes. **GitHub does not honor that**:
measured over 12 days it ran about every 5 hours (median 305 min, anywhere from 2 to 10 hours), so emailed
replies, SLA alerts and the rest all arrived hours late. This Logic App replaces it as the real trigger.

## What it is

`scheduler-logicapp.json` creates one Consumption **Logic App** with a 5-minute recurrence and four
parallel HTTP `POST` actions, one per job, each sending the `X-Cron-Secret` header. Roughly **$1 a month**
(about 1,440 executions a day). The secret is a *secure parameter*: it is typed in at deploy time, never
stored in this repo, and hidden from the portal and the deployment history; in the run history the request
(which carries the secret header) is masked while the response stays visible, so a rejected secret shows up.

Each call is cut off by Azure Static Web Apps at **45 seconds** (its limit for every API request). The jobs
are sized to finish well inside that (the email poll stops starting new messages after 25 seconds; SLA
escalation and auto-close are capped per run). If a run is ever slower, the caller can show a Failed action
while the work still completes, so treat the staff console's **Jobs** indicator as the real answer, not one
red run in the history.

The GitHub workflow (`.github/workflows/scheduled-ticks.yml`) stays in place as a backstop. That is safe:
every job takes a lease (`api/src/lib/tickLease.js`), so two callers arriving together can't run the same job
twice; the second is told it is already running and does nothing.

## Deploy it (one time, about 2 minutes)

1. Get the secret: Azure Portal, Static Web App `jetcityit-helpdesk`, **Environment variables**,
   `INTERNAL_CRON_SECRET`, show the value, copy it. (It is the same value as the GitHub repo secret of the
   same name. This is the step that has to be done by a person, not a script.)
2. Open the deploy page:
   [Deploy to Azure](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FEricYJetCityIT%2FJetCityIT-HelpDesk%2Fmain%2Finfra%2Fscheduler-logicapp.json)
3. Choose the existing resource group `jetcityit-rg` and paste the secret into **Cron Secret**.
4. Recommended: put an email address in **Alert Email** (for example a mailbox the team watches). That adds an
   Azure Monitor alert that emails when 3 or more of the scheduler's runs fail within 15 minutes, which is how
   a wrong or rotated secret (every run fails with a 401) gets noticed even when nobody has the console open.
   Leave it blank for no alert. Costs about $0.10 a month.
5. Click **Review + create**, then **Create**. (The portal validates the template first and says what is wrong
   if anything is.)

## Check it is working

- The staff console header shows a **Jobs** indicator: green "Jobs OK · just now" within a few minutes.
  Amber means a job is delayed, has not finished a run, or reported problems (for example emails that could
  not be sent, or an emailed reply it keeps failing on); red means a job failed outright. Click it for each
  job's last run and the reason.
- In Azure: the Logic App's **Runs history** should show a new run every 5 minutes, mostly Succeeded. Every
  action failing with a 401 means the secret doesn't match `INTERNAL_CRON_SECRET`; redeploy with the right
  value. An occasional single Failed action on a very slow run is not a problem if the Jobs indicator is green.
- A wrong secret writes no heartbeat at all (the secret is checked first), so the indicator just goes amber
  as it ages. The alert email in step 4 is what catches it within about 15 minutes.

## Changing the secret later

Update `INTERNAL_CRON_SECRET` on the Static Web App **and** the GitHub repo secret, then run the deploy
again with the new value (same Logic App name: it updates in place).

## Turning it off

Disable or delete the Logic App. The GitHub backstop keeps running, just slowly.
