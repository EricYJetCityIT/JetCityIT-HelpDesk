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

module.exports = { getClient, ensureTable, TABLE_NAME, genTicketId, genMessageRowKey };
