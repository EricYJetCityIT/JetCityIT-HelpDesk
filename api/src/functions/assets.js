const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse } = require('../lib/auth');
const { getClient, ensureTable, genAssetId, ASSET_TYPES, ASSET_STATUSES, findAssetById } = require('../lib/assetsTable');
const { audit } = require('../lib/audit');
const { odataEscape } = require('../lib/odata');
const { rejectIfTooLarge } = require('../lib/attachments');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  // Date.parse silently rolls a calendar-invalid date (e.g. 2024-02-30)
  // over to the next valid one instead of rejecting it -- round-tripping
  // back to an ISO date string and comparing catches that rollover.
  return d.toISOString().slice(0, 10) === s;
}

// Loose but sufficient -- this is a staff-entered field, not a public one,
// and only needs to catch an obviously malformed value before it becomes
// this table's own partition key.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function isValidDomain(s) {
  return DOMAIN_RE.test(s);
}

function assetToJson(e) {
  return {
    id: e.rowKey,
    domain: e.partitionKey,
    label: e.label,
    type: e.type,
    make: e.make || '',
    model: e.model || '',
    serial: e.serial || '',
    purchaseDate: e.purchaseDate || '',
    warrantyExpiration: e.warrantyExpiration || '',
    status: e.status,
    assignedTo: e.assignedTo || '',
    notes: e.notes || '',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function trimmed(v, max) {
  return String(v || '').trim().slice(0, max);
}

// The free-text fields are identical between a single create/update and a
// bulk-import row -- only label/domain/type/status/dates differ in how
// strictly they're enforced (see validateImportRow below), so just those
// shared ones are factored out.
function freeTextFields(body) {
  return {
    make: trimmed(body.make, 200),
    model: trimmed(body.model, 200),
    serial: trimmed(body.serial, 200),
    assignedTo: trimmed(body.assignedTo, 200),
    notes: trimmed(body.notes, 2000),
  };
}

// label and domain have no sensible default anywhere they're validated
// (a strict single create/update, or the lenient bulk import below) --
// shared so both paths enforce and report on them identically.
function validateLabelAndDomain(body) {
  const label = trimmed(body.label, 200);
  if (!label) throw new AuthError(400, 'Label is required.');

  const domain = String(body.domain || '').trim().toLowerCase();
  if (!isValidDomain(domain)) throw new AuthError(400, 'A valid client domain is required (e.g. acmecorp.com).');

  return { label, domain };
}

// Shared by create and update -- both send the complete field set (the
// staff.html form always submits every field, same spirit as the ticket
// detail view's "Save changes" always sending status+priority+category+
// assignee together), so there's no separate partial-update path to keep
// in sync with this validation.
function validateFields(body) {
  const { label, domain } = validateLabelAndDomain(body);

  const type = ASSET_TYPES.includes(body.type) ? body.type : '';
  if (!type) throw new AuthError(400, 'Invalid asset type');

  const status = ASSET_STATUSES.includes(body.status) ? body.status : '';
  if (!status) throw new AuthError(400, 'Invalid status');

  const purchaseDate = String(body.purchaseDate || '').trim();
  if (purchaseDate && !isValidDate(purchaseDate)) throw new AuthError(400, 'Invalid purchase date');

  const warrantyExpiration = String(body.warrantyExpiration || '').trim();
  if (warrantyExpiration && !isValidDate(warrantyExpiration)) throw new AuthError(400, 'Invalid warranty expiration date');

  return { label, domain, type, status, purchaseDate, warrantyExpiration, ...freeTextFields(body) };
}

const MAX_IMPORT_ROWS = 200;
const IMPORT_CONCURRENCY = 20;

// Runs `fn` over `items` with at most `limit` in flight at once, returning
// Promise.allSettled-shaped results in the original order. assetsImport
// uses this instead of firing every row's createEntity at once -- a large
// batch usually lands in a single Table Storage partition (one client's
// full inventory), and an unbounded burst risks correlated throttling that
// would otherwise show up as opaque, unrelated-looking per-row failures.
async function settleWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (e) {
        results[index] = { status: 'rejected', reason: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Returns `value` if it's in `allowed`, else `fallback` -- pushing a
// warning onto `warnings` only when `value` was actually something (an
// empty field defaulting silently isn't worth a warning).
function pickOrDefault(value, allowed, fallback, fieldLabel, warnings) {
  value = String(value || '').trim();
  if (allowed.includes(value)) return value;
  if (value) warnings.push(`${fieldLabel} "${value}" not recognized, set to ${fallback}`);
  return fallback;
}

// A deliberately more LENIENT counterpart to validateFields, used only by
// the bulk CSV import below. label and domain still have no sensible
// default and reject the row outright, but a client-supplied spreadsheet
// won't necessarily use this app's exact type/status vocabulary or always
// have clean dates -- rejecting a whole hardware record over one bad
// column would defeat the point of a bulk-onboarding tool. Invalid
// type/status/dates are defaulted/dropped instead, with a warning string
// returned per row so staff can review and fix them by hand afterward.
function validateImportRow(row) {
  const { label, domain } = validateLabelAndDomain(row);
  const warnings = [];

  const type = pickOrDefault(row.type, ASSET_TYPES, 'Other', 'type', warnings);
  const status = pickOrDefault(row.status, ASSET_STATUSES, 'Active', 'status', warnings);

  const rawPurchaseDate = String(row.purchaseDate || '').trim();
  const purchaseDate = isValidDate(rawPurchaseDate) ? rawPurchaseDate : '';
  if (rawPurchaseDate && !purchaseDate) warnings.push('purchase date left blank (not a valid date)');

  const rawWarranty = String(row.warrantyExpiration || '').trim();
  const warrantyExpiration = isValidDate(rawWarranty) ? rawWarranty : '';
  if (rawWarranty && !warrantyExpiration) warnings.push('warranty expiration left blank (not a valid date)');

  return { fields: { label, domain, type, status, purchaseDate, warrantyExpiration, ...freeTextFields(row) }, warnings };
}

// The Table Storage entity shape shared by assetCreate, assetUpdate, and
// assetsImport -- everything except partitionKey/rowKey/createdAt/updatedAt,
// which each caller supplies since they differ (a fresh id and timestamps on
// create/import vs. a preserved createdAt on update).
function entityFieldsFrom(fields) {
  return {
    label: fields.label,
    type: fields.type,
    status: fields.status,
    make: fields.make,
    model: fields.model,
    serial: fields.serial,
    assignedTo: fields.assignedTo,
    notes: fields.notes,
    purchaseDate: fields.purchaseDate,
    warrantyExpiration: fields.warrantyExpiration,
  };
}

// List all assets (optionally scoped to one client via ?domain=, a
// partition-scoped query since domain IS the partition key here).
app.http('assetsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'assets',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      await ensureTable();
      const table = getClient();

      const domain = String(request.query.get('domain') || '').trim().toLowerCase();
      const queryOptions = domain ? { filter: `PartitionKey eq '${odataEscape(domain)}'` } : {};

      const assets = [];
      for await (const e of table.listEntities({ queryOptions })) {
        assets.push(assetToJson(e));
      }
      assets.sort((a, b) => (a.label || '').localeCompare(b.label || ''));

      audit(context, user, 'asset.list', { count: assets.length, domain: domain || null });
      return { jsonBody: { assets } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('assetCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'assets',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const body = await request.json().catch(() => ({}));
      const fields = validateFields(body);

      await ensureTable();
      const table = getClient();
      const id = genAssetId();
      const now = new Date().toISOString();
      await table.createEntity({
        partitionKey: fields.domain,
        rowKey: id,
        ...entityFieldsFrom(fields),
        createdAt: now,
        updatedAt: now,
      });

      audit(context, user, 'asset.create', { id, domain: fields.domain });
      return { status: 201, jsonBody: { id } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Bulk-creates assets from staff.html's CSV import UI. Each row is
// validated and created independently (settleWithConcurrency above) -- one
// bad row (missing label, garbage domain) never blocks the good rows in
// the same file, and the per-row result (created id + any warnings, or the
// specific error) lets staff see exactly what happened rather than an
// all-or-nothing outcome for a file that could have dozens of rows.
app.http('assetsImport', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'assets/import',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);

      // Checked on the Content-Length header alone, before request.json()
      // ever reads/parses the body -- same guard every other body-accepting
      // route in this app uses (ticketReply, clientTicketReply,
      // ticketsCreate), so an oversized import request can't be fully
      // buffered and parsed into memory before MAX_IMPORT_ROWS below ever
      // gets a chance to reject it.
      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;

      const body = await request.json().catch(() => ({}));
      const rows = Array.isArray(body.assets) ? body.assets : [];

      if (!rows.length) throw new AuthError(400, 'No rows to import.');
      if (rows.length > MAX_IMPORT_ROWS) {
        throw new AuthError(400, `Cannot import more than ${MAX_IMPORT_ROWS} rows at once (got ${rows.length}).`);
      }

      await ensureTable();
      const table = getClient();
      const now = new Date().toISOString();

      const settled = await settleWithConcurrency(rows, IMPORT_CONCURRENCY, async (row) => {
        const { fields, warnings } = validateImportRow(row);
        const id = genAssetId();
        await table.createEntity({
          partitionKey: fields.domain,
          rowKey: id,
          ...entityFieldsFrom(fields),
          createdAt: now,
          updatedAt: now,
        });
        return { id, label: fields.label, warnings };
      });

      const created = [];
      const failed = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          created.push({ index, ...result.value });
        } else {
          const reason = result.reason;
          // A validation failure (bad data) vs. a transport/storage failure
          // (an id collision, throttling, a transient error -- anything
          // with an HTTP-ish statusCode from the Table Storage SDK) read
          // very differently to staff: only the latter is worth retrying.
          let message = 'Failed to create this row.';
          if (reason instanceof AuthError) {
            message = reason.message;
          } else if (reason && reason.statusCode) {
            message = `Failed to create this row (server returned ${reason.statusCode} -- safe to retry this row).`;
          }
          failed.push({ index, error: message });
        }
      });

      audit(context, user, 'asset.import', { createdCount: created.length, failedCount: failed.length });
      return { status: 201, jsonBody: { created, failed } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('assetUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'assets/{id}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { id } = request.params;
      const body = await request.json().catch(() => ({}));

      const existing = await findAssetById(id);
      if (!existing) return { status: 404, jsonBody: { error: 'Asset not found' } };

      const fields = validateFields(body);
      await ensureTable();
      const table = getClient();
      const now = new Date().toISOString();
      const entity = {
        partitionKey: fields.domain,
        rowKey: id,
        ...entityFieldsFrom(fields),
        createdAt: existing.createdAt,
        updatedAt: now,
      };

      if (fields.domain !== existing.partitionKey) {
        // Table Storage can't change a partition key in place -- moving an
        // asset to a different client means creating it under the new
        // partition and removing the old row, not a plain Merge against the
        // id's current key. The two calls aren't transactional (Table
        // Storage has no cross-partition transactions), so a failure
        // between them would otherwise leave the asset duplicated under
        // both partitions forever, with a retry 409-ing on the create.
        // Tolerating a 409 here (the new-partition row already exists, from
        // this call or a prior failed attempt) makes a retry converge on
        // the correct end state -- proceed straight to removing the old row.
        try {
          await table.createEntity(entity);
        } catch (e) {
          if (e.statusCode !== 409) throw e;
        }
        await table.deleteEntity(existing.partitionKey, id);
      } else {
        await table.updateEntity(entity, 'Merge');
      }

      audit(context, user, 'asset.update', { id, domain: fields.domain });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('assetDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'assets/{id}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { id } = request.params;

      const existing = await findAssetById(id);
      if (!existing) return { status: 404, jsonBody: { error: 'Asset not found' } };

      await ensureTable();
      const table = getClient();
      await table.deleteEntity(existing.partitionKey, id);

      audit(context, user, 'asset.delete', { id });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
