const { app } = require('@azure/functions');
const { requireStaff, AuthError, authErrorResponse } = require('../lib/auth');
const { verifyClientToken } = require('../lib/clientAccess');
const { checkRateLimit } = require('../lib/ratelimit');
const { clientIp } = require('../lib/ip');
const { getPublicKey, saveSubscription, removeSubscription, sendTest } = require('../lib/push');
const { audit } = require('../lib/audit');

// Phone alerts (lib/push.js has the whole story). Two audiences, one set of routes each:
//   staff   /api/push/{subscribe,unsubscribe,test}          signed in with Microsoft (requireStaff)
//   client  /api/client/push/{subscribe,unsubscribe,test}   email + tracking token (verifyClientToken)
//   both    GET /api/push/key                               the PUBLIC half of the signing key, which a
//                                                           browser needs in order to subscribe
// "subscribe" is also what an installed app calls, silently, each time it opens, to keep its device
// registered; "test" sends an alert to the caller's own devices only.

const MAX_BODY_CHARS = 8 * 1024; // a real subscription is well under 1 KB

function tooMany(rl) {
  return new AuthError(429, 'Too many requests -- please slow down.', { retryAfterSec: rl.retryAfterSec });
}

function ipGate(request, name, max) {
  const rl = checkRateLimit(name + ':' + clientIp(request), max, 60 * 1000);
  if (!rl.allowed) throw tooMany(rl);
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_CHARS * 4) throw new AuthError(413, 'Request too large'); // before buffering anything
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new AuthError(413, 'Request too large');
  try {
    const body = JSON.parse(text || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch (e) {
    throw new AuthError(400, 'Invalid JSON');
  }
}

// Registers subscribe / unsubscribe / test for one audience. `authenticate` turns the request (and its
// already-parsed body) into the caller's identity, throwing AuthError if they are not who they claim.
function register(audience, routePrefix, namePrefix, authenticate) {
  const handle = (run) => async (request, context) => {
    try {
      ipGate(request, 'push-' + audience, 60);
      const body = await readBody(request);
      const { identity, user } = await authenticate(request, body);
      return await run({ request, context, body, identity, user });
    } catch (e) {
      return authErrorResponse(e, context);
    }
  };

  app.http(namePrefix + 'Subscribe', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: routePrefix + '/subscribe',
    handler: handle(async ({ context, body, identity, user }) => {
      const rl = checkRateLimit('push-subscribe:' + audience + ':' + identity, 20, 60 * 1000);
      if (!rl.allowed) throw tooMany(rl);
      await saveSubscription(audience, identity, body.subscription, context);
      audit(context, user || null, 'push.subscribe', { audience });
      return { jsonBody: { ok: true } };
    }),
  });

  app.http(namePrefix + 'Unsubscribe', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: routePrefix + '/unsubscribe',
    handler: handle(async ({ context, body, identity, user }) => {
      await removeSubscription(audience, identity, String(body.endpoint || ''));
      audit(context, user || null, 'push.unsubscribe', { audience });
      return { jsonBody: { ok: true } };
    }),
  });

  app.http(namePrefix + 'Test', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: routePrefix + '/test',
    handler: handle(async ({ context, identity, user }) => {
      const rl = checkRateLimit('push-test:' + audience + ':' + identity, 5, 60 * 1000);
      if (!rl.allowed) throw tooMany(rl);
      const result = await sendTest(audience, identity, context);
      audit(context, user || null, 'push.test', { audience, devices: result.devices, sent: result.sent });
      return { jsonBody: result };
    }),
  });
}

register('staff', 'push', 'push', async (request) => {
  const user = await requireStaff(request);
  return { identity: user.upn, user };
});

register('client', 'client/push', 'clientPush', async (request, body) => {
  const identity = await verifyClientToken(String(body.email || ''), String(body.token || ''));
  return { identity, user: null };
});

// Public on purpose: this is the public half of a key pair, which every browser is handed in order to
// subscribe. (The first call anywhere creates the pair; see lib/push.js.)
app.http('pushKey', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'push/key',
  handler: async (request, context) => {
    try {
      ipGate(request, 'push-key', 30);
      return { jsonBody: { publicKey: await getPublicKey() } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
