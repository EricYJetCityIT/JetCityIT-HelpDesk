const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse } = require('../lib/auth');
const { getClient, ensureTable, genAssetId, ASSET_TYPES, ASSET_STATUSES, findAssetById } = require('../lib/assetsTable');
const { audit } = require('../lib/audit');
const { odataEscape } = require('../lib/odata');

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

// Shared by create and update -- both send the complete field set (the
// staff.html form always submits every field, same spirit as the ticket
// detail view's "Save changes" always sending status+priority+category+
// assignee together), so there's no separate partial-update path to keep
// in sync with this validation.
function validateFields(body) {
  const label = String(body.label || '').trim().slice(0, 200);
  if (!label) throw new AuthError(400, 'Label is required.');

  const domain = String(body.domain || '').trim().toLowerCase();
  if (!isValidDomain(domain)) throw new AuthError(400, 'A valid client domain is required (e.g. acmecorp.com).');

  const type = ASSET_TYPES.includes(body.type) ? body.type : '';
  if (!type) throw new AuthError(400, 'Invalid asset type');

  const status = ASSET_STATUSES.includes(body.status) ? body.status : '';
  if (!status) throw new AuthError(400, 'Invalid status');

  const purchaseDate = String(body.purchaseDate || '').trim();
  if (purchaseDate && !isValidDate(purchaseDate)) throw new AuthError(400, 'Invalid purchase date');

  const warrantyExpiration = String(body.warrantyExpiration || '').trim();
  if (warrantyExpiration && !isValidDate(warrantyExpiration)) throw new AuthError(400, 'Invalid warranty expiration date');

  return {
    label,
    domain,
    type,
    status,
    purchaseDate,
    warrantyExpiration,
    make: String(body.make || '').trim().slice(0, 200),
    model: String(body.model || '').trim().slice(0, 200),
    serial: String(body.serial || '').trim().slice(0, 200),
    assignedTo: String(body.assignedTo || '').trim().slice(0, 200),
    notes: String(body.notes || '').trim().slice(0, 2000),
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
