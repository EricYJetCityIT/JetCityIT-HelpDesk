const { TableClient } = require('@azure/data-tables');
const { odataEscape } = require('./odata');

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TABLE_NAME = 'Assets';

// A separate Table Storage table from Tickets, not a reserved partition
// within it -- assets aren't tickets and this avoids any risk of a
// crafted/typo'd asset id ever colliding with one of Tickets' own reserved
// partition names (CLIENT/CONFIG/RECURRING/EMAILDEDUP). PartitionKey is the
// client's email domain (lowercased, e.g. "acmecorp.com") -- the same
// domain string the staff console's ticket sidebar already groups by (see
// emailDomain() in staff.html) -- so listing one client's assets is a
// normal partition-scoped query, no secondary index needed.
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

function genAssetId() {
  return 'AS-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

const ASSET_TYPES = ['Laptop', 'Desktop', 'Server', 'Printer', 'Network Equipment', 'Mobile Device', 'Other'];
const ASSET_STATUSES = ['Active', 'In Repair', 'Retired', 'Spare'];

// Point lookups by id alone (no domain/partition known yet -- e.g. a ticket
// linking to an assetId, or the id-only routes assets.js exposes) need a
// cross-partition scan, since RowKey isn't the partition key here. Table
// Storage has no secondary index for this, so it's a full-table scan
// filtered server-side -- the same accepted trade-off ticketsList already
// makes on the Tickets table, and fine at help-desk/small-MSP asset
// volumes; revisit if the asset count grows into the thousands.
async function findAssetById(id) {
  await ensureTable();
  const table = getClient();
  for await (const e of table.listEntities({ queryOptions: { filter: `RowKey eq '${odataEscape(id)}'` } })) {
    return e;
  }
  return null;
}

module.exports = { getClient, ensureTable, genAssetId, ASSET_TYPES, ASSET_STATUSES, findAssetById };
