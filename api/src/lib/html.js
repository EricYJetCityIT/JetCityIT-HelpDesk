function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Staff-notification rendering of a client reply: the text, plus a one-line
// note when pictures came with it -- or instead of it, since a reply can now
// be pictures only. Without the note a staff member reading the email has no
// way to tell a text-only reply from one with screenshots waiting on the ticket.
function replyBodyHtml(text, attachmentCount) {
  const parts = [];
  if (text) parts.push(`<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`);
  if (attachmentCount) {
    const noun = attachmentCount === 1 ? 'image' : 'images';
    parts.push(`<p><em>${attachmentCount} ${noun} attached -- open the ticket to view ${attachmentCount === 1 ? 'it' : 'them'}.</em></p>`);
  }
  return parts.join('\n');
}

module.exports = { escapeHtml, replyBodyHtml };
