const { app } = require('@azure/functions');
const { requireStaff, requireAccessAdmin, authErrorResponse, STAFF_UPNS } = require('../lib/auth');
const { getUsersByUpns, getUserByUpn, listDirectoryUsers } = require('../lib/graph');
const { MAX_PAGE_STAFF, normUpn, validUpn, readPageStaff, addPageStaff, removePageStaff } = require('../lib/staffAccess');
const { audit } = require('../lib/audit');

// Staff console -> Access tab. Lets the people who are staff through AZURE (see
// requireAccessAdmin) see and change who may use the console, without touching
// Azure settings. The people set in the STAFF_UPNS app setting are shown but can
// only be changed there; this only adds/removes people ON TOP of them
// (lib/staffAccess.js). The site never writes Azure settings.
//   GET    /api/access                -> { azure:[{upn,name}], page:[{upn,name,addedBy,addedAt}], limit }
//   POST   /api/access   { upn }      -> same shape (+ `added`)
//   DELETE /api/access/{upn}          -> same shape
//   GET    /api/access-directory      -> { users:[{upn,name}] }   (for the "Name or email" picker)
// A change takes effect for that person at their next page load (and within ~30 s on every server instance).

const DIRECTORY_TTL_MS = 60 * 60 * 1000; // the company directory changes rarely; one Graph read per instance per hour
let directoryCache = null; // { users, at }

async function view() {
  const page = await readPageStaff();
  let azure;
  try {
    azure = await getUsersByUpns(STAFF_UPNS);
  } catch (e) {
    azure = STAFF_UPNS.map((upn) => ({ upn, name: null })); // names are a nicety; the list itself must still show
  }
  return { azure, page, limit: MAX_PAGE_STAFF };
}

app.http('accessList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'access',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      requireAccessAdmin(user);
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
      requireAccessAdmin(user);

      const body = await request.json().catch(() => null);
      const typed = normUpn(body && typeof body.upn === 'string' ? body.upn : '');
      if (!validUpn(typed)) return { status: 400, jsonBody: { error: 'Only @jetcityit.com email addresses can be added.' } };

      // Granting access to an address that doesn't exist yet would hand it to whoever is later given that
      // address, so the person must exist in the company directory NOW, and be enabled. Their canonical
      // sign-in name from the directory (not what was typed) is what gets stored and matched at sign-in.
      let found;
      try {
        found = await getUserByUpn(typed);
      } catch (e) {
        context.log('ACCESS_DIRECTORY_LOOKUP_FAILED ' + JSON.stringify({ error: String(e.message).slice(0, 200) }));
        return { status: 503, jsonBody: { error: "Couldn't check the company directory right now. Please try again in a moment." } };
      }
      if (!found) return { status: 404, jsonBody: { error: 'No account with that email address was found in the company directory. Check the spelling.' } };
      if (!found.enabled) return { status: 400, jsonBody: { error: 'That account is disabled.' } };
      if (!validUpn(found.upn)) return { status: 400, jsonBody: { error: 'Only @jetcityit.com accounts can be added.' } };
      if (STAFF_UPNS.includes(found.upn)) return { status: 409, jsonBody: { error: 'That person already has access (it is set in Azure).' } };

      let added;
      try {
        added = await addPageStaff({ upn: found.upn, name: found.name }, user.upn);
      } catch (e) {
        if (/Too many people/.test(e.message)) return { status: 400, jsonBody: { error: 'The list is full.' } };
        throw e;
      }
      // Security-relevant: who gave whom access is recorded (UPNs are identifiers, never message text), and
      // only when something REALLY changed.
      if (added) audit(context, user, 'access.add', { target: found.upn });
      return { jsonBody: { ...(await view()), added } };
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
      requireAccessAdmin(user);

      // The address rides in the URL path; decode it if the host handed it over still percent-encoded
      // (an '@' arrives as %40), so a removal can't miss its row just because of how the path was parsed.
      let raw = String(request.params.upn || '');
      if (/%[0-9a-f]{2}/i.test(raw)) {
        try { raw = decodeURIComponent(raw); } catch (e) { /* malformed -- use as given */ }
      }
      const target = normUpn(raw);
      if (!target || target.length > 80) return { status: 400, jsonBody: { error: 'Invalid address.' } };
      // Azure-listed people are changed in Azure only: removing one here would change nothing (the Azure list
      // always applies), so say so instead of pretending it worked.
      if (STAFF_UPNS.includes(target)) return { status: 400, jsonBody: { error: 'That person is set in Azure and can only be changed there.' } };

      const removed = await removePageStaff(target);
      if (!removed) return { status: 404, jsonBody: { error: 'That person is not on the list.' } };
      audit(context, user, 'access.remove', { target });
      return { jsonBody: { ...(await view()), removed: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Feeds the "Name or email" picker with the company directory, so someone can type a name instead of
// remembering an address. Admins only (it is a directory of everyone), and cached per instance.
app.http('accessDirectory', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'access-directory',
  handler: async (request, context) => {
    try {
      const user = await requireStaff(request);
      requireAccessAdmin(user);
      if (!directoryCache || Date.now() - directoryCache.at > DIRECTORY_TTL_MS) {
        try {
          const all = await listDirectoryUsers();
          const users = all.filter((u) => validUpn(u.upn)).sort((a, b) => String(a.name || a.upn).toLowerCase().localeCompare(String(b.name || b.upn).toLowerCase()));
          directoryCache = { users, at: Date.now() };
        } catch (e) {
          // The picker is a convenience; typing a full address still works without it.
          context.log('ACCESS_DIRECTORY_LIST_FAILED ' + JSON.stringify({ error: String(e.message).slice(0, 200) }));
          return { jsonBody: { users: [] } };
        }
      }
      return { jsonBody: { users: directoryCache.users } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
