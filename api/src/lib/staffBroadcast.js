const { sendMail, SUPPORT_MAILBOX } = require('./graph');
const { getStaffUpns } = require('./staffAccess');
const { pushToStaff } = require('./push');

// Broadcasts an event to the WHOLE staff team (the Azure STAFF_UPNS list plus
// anyone added on the Access tab), not just whoever's assigned or whoever
// happens to be watching the shared support inbox -- so anyone can notice a
// client follow-up sitting unanswered even if the assigned tech hasn't
// gotten to it yet. One message with everyone in the To line, not a separate
// send per person.
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
async function notifyStaffTeam(context, { subject, html, excludeUpn, push, pushExclude }) {
  try {
    const staff = await getStaffUpns();
    const recipients = excludeUpn ? staff.filter((upn) => upn !== excludeUpn.toLowerCase()) : staff;
    if (!recipients.length) return;
    // `push` (optional) is the same news as a phone alert (lib/push.js): sent alongside the email, not
    // after it, so it adds no time to the caller. pushToStaff never throws, and it only alerts people who
    // are staff right now. `pushExclude` leaves people out of the ALERT only -- e.g. a new ticket's
    // assignee, who gets their own, more specific "assigned to you" alert instead.
    const alert = push
      ? pushToStaff(context, push, { only: recipients, exclude: pushExclude })
      : Promise.resolve();
    const mail = await sendMail({ from: SUPPORT_MAILBOX, to: recipients, subject, html }).then(() => null, (e) => e);
    await alert;
    if (mail) throw mail;
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
