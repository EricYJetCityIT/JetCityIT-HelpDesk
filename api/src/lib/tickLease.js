const crypto = require('crypto');
const { getClient, ensureTable } = require('./tables');

// The four background jobs (email-in replies, SLA escalation, recurring tickets, auto-close) are plain
// HTTP endpoints under /api/internal/*, called by whatever scheduler is wired up (an Azure Logic App,
// and GitHub Actions as a backstop -- see api/AUTHORIZATION.md). Two things every job needs no matter
// who calls it, both kept in ONE row per job under the reserved CONFIG partition (RowKey
// 'tick-<job>', kind 'config' -- never 'meta', so it never shows up as a ticket):
//
//  1. A LEASE, so two callers arriving together can't both run the same job. Without it an overlap
//     could post an emailed reply twice (the dedup marker is only written after a message is
//     handled), create a recurring ticket twice (the "due" check runs before lastCreatedAt is
//     advanced) or send an SLA escalation twice. The caller that loses the race is told the job is
//     already running and does nothing. A lease that is never released (the function was killed)
//     simply expires after LEASE_MS, so a crash can never stop a job for good.
//  2. A HEARTBEAT (when it last started/finished and whether it worked), which the staff console
//     shows. The scheduler is outside this app, and the previous one (GitHub's cron) ran these jobs
//     only every few hours with nothing anywhere saying so; this makes "is it running?" visible.
const PARTITION = 'CONFIG';
const LEASE_MS = 5 * 60 * 1000; // longer than any one run (the request itself is cut off by the gateway at ~4 min)

const JOBS = {
  'email-ingest': 'Email replies',
  'sla-escalation': 'SLA escalation',
  'recurring-tickets': 'Recurring tickets',
  'auto-close': 'Auto-close',
};

const rowKeyFor = (job) => 'tick-' + job;
const iso = (ms) => new Date(ms).toISOString();

// Runs `fn` only if no other caller holds this job's lease. Resolves { skipped: true } when another
// run is in progress, or { skipped: false, result } with whatever `fn` returned. Errors from `fn`
// are recorded in the heartbeat and then re-thrown, so the endpoint answers exactly as before.
// Failing to read or write the lease row itself throws (the job doesn't run): better to miss one
// tick than to run it unprotected.
async function withTickLease(job, context, fn) {
  if (!JOBS[job]) throw new Error('Unknown job ' + job);
  await ensureTable();
  const table = getClient();
  const rowKey = rowKeyFor(job);
  const holder = crypto.randomBytes(8).toString('hex');
  const startedAt = Date.now();
  const mine = { partitionKey: PARTITION, rowKey, kind: 'config', holder, leaseUntil: iso(startedAt + LEASE_MS), lastStartedAt: iso(startedAt) };

  let existing = null;
  try {
    existing = await table.getEntity(PARTITION, rowKey);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }

  try {
    if (!existing) {
      await table.createEntity(mine);
    } else {
      if ((Date.parse(existing.leaseUntil) || 0) > startedAt) return { skipped: true };
      // Conditional on the row being exactly as just read, so two callers finding the same expired lease
      // can't both take it: the second gets a 412.
      await table.updateEntity(mine, 'Merge', { etag: existing.etag });
    }
  } catch (e) {
    if (e.statusCode === 409 || e.statusCode === 412) return { skipped: true }; // lost the race
    throw e;
  }

  let result;
  let failure = null;
  try {
    result = await fn();
  } catch (e) {
    failure = e;
  }

  // Release + heartbeat. Only if the lease is still ours: if this run overran LEASE_MS and another
  // caller took over, their row must not be cleared. Never throws -- the job's own outcome matters more.
  try {
    const row = await table.getEntity(PARTITION, rowKey);
    if (row.holder === holder) {
      await table.updateEntity({
        partitionKey: PARTITION,
        rowKey,
        leaseUntil: '',
        lastFinishedAt: iso(Date.now()),
        lastResult: failure ? 'error' : 'ok',
        lastError: failure ? String((failure && failure.message) || failure).slice(0, 200) : '',
      }, 'Merge');
    }
  } catch (e) {
    try { context.log('TICK_HEARTBEAT_FAILED ' + JSON.stringify({ job, error: String(e.message).slice(0, 160) })); } catch (_) { /* logging must never break the job */ }
  }

  if (failure) throw failure;
  return { skipped: false, result };
}

// What the staff console shows: one entry per job, in a fixed order. A job that has never run (or whose
// row can't be read) comes back with null times, never an exception.
async function readJobStatus() {
  await ensureTable();
  const table = getClient();
  const now = Date.now();
  return Promise.all(Object.keys(JOBS).map(async (job) => {
    const base = { job, label: JOBS[job], lastStartedAt: null, lastFinishedAt: null, lastResult: null, lastError: '', running: false, unknown: false };
    try {
      const row = await table.getEntity(PARTITION, rowKeyFor(job));
      return {
        ...base,
        lastStartedAt: row.lastStartedAt || null,
        lastFinishedAt: row.lastFinishedAt || null,
        lastResult: row.lastResult || null,
        lastError: row.lastError || '',
        running: (Date.parse(row.leaseUntil) || 0) > now,
      };
    } catch (e) {
      // 404 = the job has simply never run. Anything else means we couldn't ask, which must not be
      // shown as "never ran".
      return e.statusCode === 404 ? base : { ...base, unknown: true };
    }
  }));
}

module.exports = { withTickLease, readJobStatus, JOBS, LEASE_MS };
