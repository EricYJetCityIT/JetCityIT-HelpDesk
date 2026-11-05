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
stored in this repo, and hidden from the portal, the deployment history and the run history.

The GitHub workflow (`.github/workflows/scheduled-ticks.yml`) stays in place as a backstop. That is safe:
every job takes a lease (`api/src/lib/tickLease.js`), so two callers arriving together can't run the same job
twice; the second is told it is already running and does nothing.

## Deploy it (one time, about 2 minutes)

1. Get the secret: Azure Portal, Static Web App `jetcityit-helpdesk`, **Environment variables**,
   `INTERNAL_CRON_SECRET`, show the value, copy it. (It is the same value as the GitHub repo secret of the
   same name. This is the step that has to be done by a person, not a script.)
2. Open the deploy page:
   [Deploy to Azure](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FEricYJetCityIT%2FJetCityIT-HelpDesk%2Fmain%2Finfra%2Fscheduler-logicapp.json)
3. Choose the existing resource group `jetcityit-rg`, paste the secret into **Cron Secret**, leave the rest
   as is, and click **Review + create**, then **Create**.

## Check it is working

- The staff console header shows a **Jobs** indicator: green "Jobs OK · just now" within a few minutes.
  Amber means delayed or never run; red means a job reported an error. Click it for each job's last run.
- In Azure: the Logic App's **Runs history** should show a new run every 5 minutes, all Succeeded. A failed
  run with a 401 on every action means the secret doesn't match `INTERNAL_CRON_SECRET`; redeploy with the
  right value.

## Changing the secret later

Update `INTERNAL_CRON_SECRET` on the Static Web App **and** the GitHub repo secret, then run the deploy
again with the new value (same Logic App name: it updates in place).

## Turning it off

Disable or delete the Logic App. The GitHub backstop keeps running, just slowly.
