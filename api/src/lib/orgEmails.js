const { escapeHtml } = require('./html');
const { sendMail, SUPPORT_MAILBOX } = require('./graph');
const { genToken } = require('./tokens');
const { getClient, ensureTable } = require('./orgUsers');

const TEAM_HTML_URL = 'https://helpdesk.jetcityit.com/team.html';

// Shared by orgPortal.js (signup, resend-verification) and orgAdmin.js
// (staff-triggered password reset) -- both need to generate a fresh,
// single-use token, store it on the account row, and email a link built
// from it. Pulled into its own lib file (rather than living in orgPortal.js
// alone) specifically so orgAdmin.js can reuse the same pattern for
// password-reset emails without a functions-file-to-functions-file import.

// Regenerates the token each time so an old, possibly-leaked verification
// email stops working once a new one is sent.
async function sendVerificationEmail(name, email, domain, context) {
  const verifyToken = genToken();
  await ensureTable();
  await getClient().updateEntity({ partitionKey: domain, rowKey: email, verifyToken }, 'Merge');
  const link = `${TEAM_HTML_URL}?verifyEmail=${encodeURIComponent(email)}&verifyToken=${encodeURIComponent(verifyToken)}`;
  try {
    const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Confirm your email to finish setting up Jet City IT organization portal access for <strong>${escapeHtml(domain)}</strong>:</p>
<p><a href="${escapeHtml(link)}">Verify my account</a></p>
<p>If you didn't request this, you can safely ignore this email.</p>
<p>— Jet City IT Help Desk</p>`;
    await sendMail({ from: SUPPORT_MAILBOX, to: email, subject: 'Verify your Jet City IT organization portal account', html });
  } catch (e) {
    context.log('ORG_VERIFY_EMAIL_FAILED ' + JSON.stringify({ email, error: e.message }));
  }
}

// Staff-triggered (api/src/functions/orgAdmin.js), or dispatched on staff's
// behalf after a self-service "Forgot your password?" ticket comes in.
// Returns whether the email actually sent -- the caller uses this to decide
// whether it's honest to clear a pending "reset requested" flag; the
// generic {ok:true} response it returns to its own caller is unaffected
// either way, same as every other best-effort email in this app.
async function sendPasswordResetEmail(name, email, domain, context) {
  const resetToken = genToken();
  await ensureTable();
  await getClient().updateEntity({ partitionKey: domain, rowKey: email, resetToken }, 'Merge');
  const link = `${TEAM_HTML_URL}?resetEmail=${encodeURIComponent(email)}&resetToken=${encodeURIComponent(resetToken)}`;
  try {
    const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Jet City IT staff started a password reset for your organization portal account (${escapeHtml(domain)}). Choose a new password here:</p>
<p><a href="${escapeHtml(link)}">Set a new password</a></p>
<p>If you didn't expect this, contact Jet City IT before using the link.</p>
<p>— Jet City IT Help Desk</p>`;
    await sendMail({ from: SUPPORT_MAILBOX, to: email, subject: 'Reset your Jet City IT organization portal password', html });
    return true;
  } catch (e) {
    context.log('ORG_RESET_EMAIL_FAILED ' + JSON.stringify({ email, error: e.message }));
    return false;
  }
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
