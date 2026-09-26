const { sendMail, SUPPORT_MAILBOX } = require('./graph');
const { STAFF_UPNS } = require('./auth');

// Broadcasts an event to the WHOLE staff team (every entry in STAFF_UPNS),
// not just whoever's assigned or whoever happens to be watching the
// shared support inbox -- so anyone can notice a client follow-up sitting
// unanswered even if the assigned tech hasn't gotten to it yet. One
// message with everyone in the To line, not a separate send per person.
// `excludeUpn` drops one address from that list -- e.g. the assignee
// themselves shouldn't be told they just replied to their own ticket.
// Deliberately best-effort/self-swallowing (never throws): this is an
// FYI broadcast layered on top of the core ticket flow, not something
// that should ever block a ticket being created or a reply being saved.
// Every call site relies on that guarantee to await this with no
// try/catch of its own, so even the failure-logging path below is
// guarded -- a throw from context.log itself (unlikely, but exactly the
// kind of thing this function promises never to let through) would
// otherwise still break that guarantee.
async function notifyStaffTeam(context, { subject, html, excludeUpn }) {
  const recipients = excludeUpn ? STAFF_UPNS.filter((upn) => upn !== excludeUpn.toLowerCase()) : STAFF_UPNS;
  if (!recipients.length) return;
  try {
    await sendMail({ from: SUPPORT_MAILBOX, to: recipients, subject, html });
  } catch (e) {
    try {
      context.log('STAFF_BROADCAST_FAILED ' + JSON.stringify({ error: e.message }));
    } catch (e2) {
      // Truly nothing left to do here -- swallow rather than risk this
      // function throwing after all.
    }
  }
}

module.exports = { notifyStaffTeam };
