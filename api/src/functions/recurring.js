const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse, STAFF_UPNS } = require('../lib/auth');
const { getClient, ensureTable, TICKET_CATEGORIES } = require('../lib/tables');
const { audit } = require('../lib/audit');

const PRIORITIES = ['Low', 'Normal', 'High'];
// Reserved partition, same pattern as CLIENT (clientAccess.js) and CONFIG
// (ticketsPublic.js's round-robin counter) -- templates aren't tickets, so
// they never get a kind: 'meta' row and never surface in ticketsList.
const PARTITION = 'RECURRING';

function genTemplateId() {
  return 'RT-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function templateToJson(e) {
  return {
    id: e.rowKey,
    subject: e.subject,
    description: e.description,
    category: e.category || 'Other',
    priority: e.priority,
    assignee: e.assignee || '',
    intervalDays: e.intervalDays,
    active: !!e.active,
    lastCreatedAt: e.lastCreatedAt || null,
    createdAt: e.createdAt,
  };
}

app.http('recurringList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'recurring',
  handler: async (request, context) => {
    try {
      await requireStaff(request);
      await ensureTable();
      const table = getClient();
      const templates = [];
      for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } })) {
        templates.push(templateToJson(e));
      }
      templates.sort((a, b) => (a.subject || '').localeCompare(b.subject || ''));
      return { jsonBody: { templates } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('recurringCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'recurring',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const body = await request.json().catch(() => ({}));

      const subject = String(body.subject || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 5000);
      const category = TICKET_CATEGORIES.includes(body.category) ? body.category : 'Other';
      const priority = PRIORITIES.includes(body.priority) ? body.priority : 'Normal';
      const assignee = String(body.assignee || '').trim().toLowerCase();
      const intervalDays = Math.round(Number(body.intervalDays));

      if (!subject || !description) throw new AuthError(400, 'Subject and description are required.');
      if (!Number.isFinite(intervalDays) || intervalDays < 1 || intervalDays > 365) {
        throw new AuthError(400, 'Interval must be a whole number of days between 1 and 365.');
      }
      if (assignee && !STAFF_UPNS.includes(assignee)) throw new AuthError(400, 'Invalid assignee');

      await ensureTable();
      const table = getClient();
      const id = genTemplateId();
      await table.createEntity({
        partitionKey: PARTITION,
        rowKey: id,
        subject,
        description,
        category,
        priority,
        assignee,
        intervalDays,
        active: true,
        lastCreatedAt: '',
        createdAt: new Date().toISOString(),
      });

      audit(context, user, 'recurring.create', { id });
      return { status: 201, jsonBody: { id } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('recurringUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'recurring/{id}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { id } = request.params;
      const body = await request.json().catch(() => ({}));

      await ensureTable();
      const table = getClient();
      try {
        await table.getEntity(PARTITION, id);
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Template not found' } };
        throw e;
      }

      const update = { partitionKey: PARTITION, rowKey: id };
      if (body.subject !== undefined) {
        const subject = String(body.subject || '').trim().slice(0, 200);
        if (!subject) throw new AuthError(400, 'Subject is required.');
        update.subject = subject;
      }
      if (body.description !== undefined) {
        const description = String(body.description || '').trim().slice(0, 5000);
        if (!description) throw new AuthError(400, 'Description is required.');
        update.description = description;
      }
      if (body.category !== undefined) {
        if (!TICKET_CATEGORIES.includes(body.category)) throw new AuthError(400, 'Invalid category');
        update.category = body.category;
      }
      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) throw new AuthError(400, 'Invalid priority');
        update.priority = body.priority;
      }
      if (body.assignee !== undefined) {
        const assignee = String(body.assignee || '').trim().toLowerCase();
        if (assignee && !STAFF_UPNS.includes(assignee)) throw new AuthError(400, 'Invalid assignee');
        update.assignee = assignee;
      }
      if (body.intervalDays !== undefined) {
        const intervalDays = Math.round(Number(body.intervalDays));
        if (!Number.isFinite(intervalDays) || intervalDays < 1 || intervalDays > 365) {
          throw new AuthError(400, 'Interval must be a whole number of days between 1 and 365.');
        }
        update.intervalDays = intervalDays;
      }
      if (body.active !== undefined) update.active = !!body.active;

      await table.updateEntity(update, 'Merge');
      audit(context, user, 'recurring.update', { id, fields: Object.keys(body) });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('recurringDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'recurring/{id}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      const { id } = request.params;
      await ensureTable();
      const table = getClient();
      try {
        await table.deleteEntity(PARTITION, id);
      } catch (e) {
        if (e.statusCode === 404) return { status: 404, jsonBody: { error: 'Template not found' } };
        throw e;
      }
      audit(context, user, 'recurring.delete', { id });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
