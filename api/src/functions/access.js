const { app } = require('@azure/functions');
const { requireStaff, requireAccessAdmin, authErrorResponse, AZURE_STAFF_UPNS } = require('../lib/auth');
const { getUsersByUpns, getUserByUpn, listDirectoryUsers } = require('../lib/graph');
const { MAX_PAGE_STAFF, normUpn, validUpn, readPageStaff, addPageStaff, removePageStaff } = require('../lib/staffAccess');
const { audit } = require('../lib/audit');
const { removeAllSubscriptions } = require('../lib/push');

// Staff console -> Access tab. Lets the people who are staff through AZURE (see
// requireAccessAdmin) see and change who may use the console, without touching
// Azure settings. The people set in the STAFF_UPNS app setting are shown but can
// only be changed there; this only adds/removes people ON TOP of them
// (lib/staffAccess.js). The site never writes Azure settings.
//   GET    /api/access                -> { azure:[{upn,name}], page:[{upn,name,addedBy,addedAt}], limit }
//   POST   /api/access   { upn }      -> same shape (+ `added`)
//   DELETE /api/access/{upn}          -> same shape (+ `removed`)
//   GET    /api/access-directory      -> { users:[{upn,name}] }   (for the "Name or email" picker)
// A change takes effect for that person at their next page load (and within ~30 s on every server instance).

const DIRECTORY_TTL_MS = 60 * 60 * 1000;   // the company directory changes rarely; one Graph read per instance per hour
const DIRECTORY_RETRY_MS = 60 * 1000;      // after a failed read, don't re-run a slow multi-page Graph call on every tab open
let directoryCache = null;                 // { users, at }
let directoryFailedAt = 0;
let directoryInflight = null;

// Admin gate that leaves a trace of who tried: a denied attempt to open or change who is staff is
// exactly the kind of event an audit log is for.
function gate(user, context, route) {
  try {
    requireAccessAdmin(user);
  } catch (e) {
    audit(context, user, 'access.denied', { route });
    throw e;
  }
}

// What the tab shows. Names for Azure people come from Graph (best effort); page-added people carry
// the name they were added with, so listing them never costs a Graph call.
async function view() {
  const page = await readPageStaff();
  let azure;
  try {
    azure = await getUsersByUpns(AZURE_STAFF_UPNS);
  } catch (e) {
    azure = AZURE_STAFF_UPNS.map((upn) => ({ upn, name: null })); // names are a nicety; the list itself must still show
  }
  return { azure, page, limit: MAX_PAGE_STAFF };
}

// For the response to a change that has ALREADY been saved: if building the fresh view fails, the
// change must not be reported as a failure. The client sees `{}` (no lists) and reloads the tab.
async function viewAfterChange() {
  try {
    return await view();
  } catch (e) {
    return {};
  }
}

async function loadDirectory(context) {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) return directoryCache.users;
  if (Date.now() - directoryFailedAt < DIRECTORY_RETRY_MS) return [];
  if (!directoryInflight) {
    const p = (async () => {
      try {
        const all = await listDirectoryUsers();
        const users = all
          .filter((u) => validUpn(u.upn))
          .sort((a, b) => String(a.name || a.upn).toLowerCase().localeCompare(String(b.name || b.upn).toLowerCase()));
        directoryCache = { users, at: Date.now() };
        return users;
      } catch (e) {
        // The picker is a convenience; typing a full address still works without it.
        directoryFailedAt = Date.now();
        context.log('ACCESS_DIRECTORY_LIST_FAILED ' + JSON.stringify({ error: String(e.message).slice(0, 200) }));
        return [];
      } finally {
        if (directoryInflight === p) directoryInflight = null;
      }
    })();
    directoryInflight = p;
  }
  return directoryInflight;
}

app.http('accessList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'access',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      gate(user, context, 'list');
      return { jsonBody: await view() };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('accessAdd', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'access',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      gate(user, context, 'add');

      const body = await request.json().catch(() => null);
      const typed = normUpn(body && typeof body.upn === 'string' ? body.upn : '');
      if (!validUpn(typed)) return { status: 400, jsonBody: { error: 'Only @jetcityit.com email addresses can be added.' } };

      // Granting access to an address that doesn't exist yet would hand it to whoever is later given that
      // address, so the person must exist in the company directory NOW, and be enabled. Their canonical
      // sign-in name from the directory (not what was typed) and their account's object id are what get
      // stored; sign-in then requires both to match.
      let found;
      try {
        found = await getUserByUpn(typed);
      } catch (e) {
        context.log('ACCESS_DIRECTORY_LOOKUP_FAILED ' + JSON.stringify({ error: String(e.message).slice(0, 200) }));
        return { status: 503, jsonBody: { error: "Couldn't check the company directory right now. Please try again in a moment." } };
      }
      if (!found) return { status: 404, jsonBody: { error: 'No account with that email address was found in the company directory. Check the spelling.' } };
      if (!found.enabled) return { status: 400, jsonBody: { error: 'That account is disabled.' } };
      if (!validUpn(found.upn) || !found.oid) return { status: 400, jsonBody: { error: 'Only @jetcityit.com accounts can be added.' } };
      if (AZURE_STAFF_UPNS.includes(found.upn)) return { status: 409, jsonBody: { error: 'That person already has access (it is set in Azure).' } };

      let added;
      try {
        added = await addPageStaff({ upn: found.upn, name: found.name, oid: found.oid }, user.upn);
      } catch (e) {
        if (/Too many people/.test(e.message)) return { status: 400, jsonBody: { error: 'The list is full.' } };
        throw e;
      }
      // Security-relevant: who gave whom access is recorded (UPNs are identifiers, never message text), and
      // only when something REALLY changed.
      if (added) audit(context, user, 'access.add', { target: found.upn });
      return { jsonBody: { ...(await viewAfterChange()), added } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

app.http('accessRemove', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'access/{upn}',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      gate(user, context, 'remove');

      // The address rides in the URL path; decode it if the host handed it over still percent-encoded
      // (an '@' arrives as %40), so a removal can't miss its row just because of how the path was parsed.
      let raw = String(request.params.upn || '');
      if (/%[0-9a-f]{2}/i.test(raw)) {
        try { raw = decodeURIComponent(raw); } catch (e) { /* malformed -- use as given */ }
      }
      const target = normUpn(raw);
      if (!validUpn(target)) return { status: 400, jsonBody: { error: 'Invalid address.' } };

      // Only the page-added row can be removed here. If there isn't one and the person is Azure-listed,
      // say so instead of pretending it worked -- Azure's list always applies. (A person who is in BOTH
      // lists can still have their page row removed, so dropping them from Azure later really does revoke.)
      const removed = await removePageStaff(target);
      if (!removed) {
        if (AZURE_STAFF_UPNS.includes(target)) return { status: 400, jsonBody: { error: 'That person is set in Azure and can only be changed there.' } };
        return { status: 404, jsonBody: { error: 'That person is not on the list.' } };
      }
      audit(context, user, 'access.remove', { target });
      // Their phones stop getting alerts right now -- unless Azure still lists them, in which case they are
      // still staff. (Alerts also only ever go to people who are on the staff list at the moment of sending,
      // so this is tidying up, not the safeguard -- a failure here is harmless.)
      if (!AZURE_STAFF_UPNS.includes(target)) {
        await removeAllSubscriptions('staff', target).catch((e) => {
          context.log('ACCESS_PUSH_CLEANUP_FAILED ' + JSON.stringify({ error: String(e && e.message).slice(0, 200) }));
        });
      }
      return { jsonBody: { ...(await viewAfterChange()), removed: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Feeds the "Name or email" picker with the company directory, so someone can type a name instead of
// remembering an address. Admins only (it is a directory of everyone), cached per instance, and a
// failure is remembered briefly so a Graph problem isn't re-run on every tab open.
app.http('accessDirectory', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'access-directory',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      gate(user, context, 'directory');
      return { jsonBody: { users: await loadDirectory(context) } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
