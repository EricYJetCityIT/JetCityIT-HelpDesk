// Lightweight audit logging for security-relevant events (writes, permission
// denials). Emits a single structured JSON line to Application Insights via
// context.log, so you can query/alert on it later.
//
// IMPORTANT: log actor + action + resource identifiers only — NEVER ticket
// body content or requester PII values.

function audit(context, user, action, detail) {
  try {
    context.log(
      'AUDIT ' +
        JSON.stringify({
          audit: true,
          ts: new Date().toISOString(),
          upn: user && user.upn ? user.upn : null,
          action,
          ...(detail || {}),
        })
    );
  } catch (_) {
    // Logging must never break a request.
  }
}

module.exports = { audit };
