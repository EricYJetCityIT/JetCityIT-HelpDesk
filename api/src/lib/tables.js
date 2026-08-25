const { TableClient } = require('@azure/data-tables');

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TABLE_NAME = 'Tickets';

// Single-table design: one Table Storage table holds both ticket metadata and
// thread messages, partitioned by ticketId. RowKey '0' is always the ticket's
// meta row (sorts first, string '0' < any millisecond-timestamp string);
// every message row's RowKey is a millisecond timestamp (+ a short random
// suffix to avoid same-millisecond collisions) — a fixed-width 13-digit
// number until the year 2286, so plain string sort keeps messages
// chronological with no separate index/table needed at this volume.
let client;
let ensured;
function getClient() {
  if (!client) {
    if (!CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
    client = TableClient.fromConnectionString(CONNECTION_STRING, TABLE_NAME);
  }
  return client;
}

// Creates the table on first use per Function instance (cold start). Cached
// so warm invocations skip the round-trip; "already exists" is expected on
// every instance after the first and is not an error.
async function ensureTable() {
  if (!ensured) {
    ensured = getClient()
      .createTable()
      .catch((e) => {
        if (e.statusCode !== 409) throw e;
      });
  }
  return ensured;
}

function genTicketId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `HD-${d}-${suffix}`;
}

function genMessageRowKey() {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${String(Date.now())}-${suffix}`;
}

// Shared between ticketsCreate (client-facing, validates the submitted
// value) and ticketUpdate (staff-facing, lets a miscategorized ticket be
// corrected) -- centralized here rather than duplicated so the two can't
// silently drift out of sync.
const TICKET_CATEGORIES = ['Hardware', 'Software', 'Network', 'Account Access', 'Billing', 'Other'];

// A staff-only, human-readable audit trail entry (kind: 'activity'), shown
// in the console alongside the message thread. Deliberately separate from
// the structured server-log audit() calls (Application Insights, not
// queryable by staff day-to-day) -- this is the "who changed what, when"
// staff actually see in the UI. Best-effort and self-swallowing: a missed
// activity entry is a minor UX gap, never a reason to fail the real
// mutation it's describing. Client-facing reads (clientTicketGet) only ever
// surface kind === 'message' rows, so these never reach a client.
async function recordActivity(table, ticketId, text) {
  try {
    await table.createEntity({
      partitionKey: ticketId,
      rowKey: genMessageRowKey(),
      kind: 'activity',
      body: text,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // swallow -- see comment above
  }
}

module.exports = { getClient, ensureTable, TABLE_NAME, genTicketId, genMessageRowKey, TICKET_CATEGORIES, recordActivity };
