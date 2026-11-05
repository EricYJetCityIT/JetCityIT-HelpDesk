const { listMessageAttachments, getMessageAttachment, getMessageUniqueBodyHtml } = require('./graph');
const { storeAttachments, deleteAttachments, AttachmentError, MAX_FILE_BYTES, MAX_TOTAL_BYTES_PER_MESSAGE } = require('./attachments');

// Same "up to 4 images" the portals' reply forms allow.
const MAX_IMAGES = 4;
// Cap on per-attachment downloads for one email. An inline image has to be
// downloaded before we can tell whether the email body actually references it
// (see importEmailAttachments), so a message dragging along a pile of
// signature icons and quoted-history pictures can't be allowed to trigger an
// unbounded number of Graph calls inside the 5-minute poll.
const MAX_FETCHES = 10;

const IMAGE_TYPE_RE = /^image\/(png|jpe?g|gif|webp)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// The email poll asks Graph for uniqueBody as plain text, and an image pasted
// into the email shows up there as a "[cid:image001.png@01DD6C49.E04F9FF0]"
// placeholder. Meaningless to anyone reading the ticket, so it's removed --
// along with the blank-line runs it leaves behind (Outlook already pads
// paragraphs with several). Text with no placeholder is returned untouched, so
// an ordinary reply (pasted logs, code) keeps its blank lines exactly.
function stripCidPlaceholders(text) {
  const s = String(text || '');
  if (!/\[cid:/i.test(s)) return s;
  return s
    .replace(/\[cid:[^\]\r\n]*\]/gi, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/(\r?\n){3,}/g, '\n\n');
}

// Whether `haystack` (the email body as text or HTML) references an inline
// attachment by its content id. An inline image the body does NOT reference
// belongs to quoted history, not to what this person just sent -- Outlook
// re-attaches earlier pictures on a reply -- so it isn't theirs to add to the
// ticket again. Angle brackets around the id are tolerated, and the id must
// end at a boundary so "ii_1" can't match a reference to "ii_10".
function referencesCid(haystack, contentId) {
  const id = String(contentId || '').trim().replace(/^<|>$/g, '');
  if (!id) return false;
  const re = new RegExp('cid:' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9._@-])', 'i');
  const raw = String(haystack || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (e) {
    // a stray "%" -- the raw text is still checked
  }
  return re.test(raw) || re.test(decoded);
}

function looksLikeImage(meta) {
  return IMAGE_TYPE_RE.test(meta.contentType || '') || IMAGE_EXT_RE.test(meta.name || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A Graph failure worth trying again -- now, and on the next poll: throttling,
// a server error, or no response at all. Anything else (403 for a missing
// permission, 404 for a deleted message) won't fix itself.
function isTransient(e) {
  return !e.status || e.status === 429 || e.status >= 500;
}

// One quick retry for a transient Graph failure, honoring Retry-After (capped
// so a long throttle doesn't eat the poll's time budget).
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isTransient(e)) throw e;
    await sleep(Math.min((Number(e.retryAfter) || 0) * 1000 || 500, 3000));
    return fn();
  }
}

// Imports the picture attachments of one inbound email onto `ticketId`, using
// the same byte-sniffing/size validation as a portal upload (storeAttachments)
// -- the declared content type and filename are never trusted. `rawText` is
// the email's unique body as plain text with its [cid:...] placeholders still
// in place. Returns { stored, skipped, failed }:
//   stored  -- attachment metadata, ready for the message row's attachmentsJson
//   skipped -- [{ name, reason }] for everything the sender attached that we
//              did NOT import, so staff can go and look in the mailbox
//   failed  -- true if the attachment list itself couldn't be read
// What happens on an error depends on whether it can heal: a permanent one
// (permission, missing item, a bad file) degrades to skipped/failed right
// away, so it can never wedge the poll for every later email. A TRANSIENT one
// (throttling, a Graph/storage outage) throws -- after deleting whatever this
// call already stored -- so the email is retried on the next poll, EXCEPT once
// `giveUp` is set (the caller sets it when the email is old enough that waiting
// longer is clearly not helping): then it degrades too, and the email goes
// through as text with a "not imported" note instead of blocking the mailbox.
async function importEmailAttachments(ticketId, messageId, rawText, { giveUp = false } = {}) {
  const result = { stored: [], skipped: [], failed: false };

  let metas;
  try {
    metas = await withRetry(() => listMessageAttachments(messageId));
  } catch (e) {
    if (isTransient(e) && !giveUp) throw e;
    result.failed = true;
    return result;
  }
  // The sender's own attachments first: in a long thread Outlook re-attaches
  // every earlier inline picture too, and those must not use up the download
  // budget before a real attachment further down the list is reached.
  metas = metas.slice().sort((a, b) => Number(Boolean(a.isInline)) - Number(Boolean(b.isInline)));

  // The text body only shows an inline image as "[cid:...]" some of the time
  // (a client that generated alt text for the picture can render that instead),
  // so when the text doesn't settle it, the HTML body -- where the reference is
  // always an <img src="cid:..."> -- is fetched once and checked too.
  let bodyHtml;
  async function inlineIsReferenced(contentId) {
    if (referencesCid(rawText, contentId)) return true;
    if (bodyHtml === undefined) {
      try {
        bodyHtml = await withRetry(() => getMessageUniqueBodyHtml(messageId));
      } catch (e) {
        if (isTransient(e) && !giveUp) throw e;
        bodyHtml = '';
      }
    }
    return referencesCid(bodyHtml, contentId);
  }

  let totalBytes = 0;
  let fetches = 0;
  let overLimit = 0;
  let unchecked = 0;
  try {
    for (const meta of metas) {
      const name = meta.name || 'attachment';
      // @odata.type survives $select (and carries the "#"), but a missing one
      // is tolerated: the contentBytes check after the download tells a real
      // file from an attached email/calendar item or a cloud link.
      const odataType = meta['@odata.type'];
      const isFileType = !odataType || /fileAttachment$/i.test(odataType);

      if (!isFileType || !looksLikeImage(meta)) {
        // Inline non-images (rare) aren't worth a staff note; anything the
        // sender explicitly attached is.
        if (!meta.isInline) result.skipped.push({ name, reason: 'not a PNG/JPG/GIF/WEBP image' });
        continue;
      }
      if (meta.size > MAX_FILE_BYTES) {
        result.skipped.push({ name, reason: 'larger than 10 MB' });
        continue;
      }
      if (fetches >= MAX_FETCHES) {
        unchecked++;
        continue;
      }
      fetches++;

      let att;
      try {
        att = await withRetry(() => getMessageAttachment(messageId, meta.id));
      } catch (e) {
        if (isTransient(e) && !giveUp) throw e;
        result.skipped.push({ name, reason: 'could not be downloaded' });
        continue;
      }
      if (!att || !att.contentBytes) {
        result.skipped.push({ name, reason: 'not a file attachment' });
        continue;
      }
      if (meta.isInline && !(await inlineIsReferenced(att.contentId))) continue;
      // Checked only now, after the reference test, so quoted-history pictures
      // that were never going to be imported can't push a real one over the cap
      // or inflate the "N more images" count.
      if (result.stored.length >= MAX_IMAGES) {
        overLimit++;
        continue;
      }

      // Graph's size is the decoded size; this is the same combined cap
      // storeAttachments enforces, checked here so one oversized image is
      // reported on its own rather than failing the whole batch.
      const size = meta.size || Math.floor(att.contentBytes.length * 0.75);
      if (totalBytes + size > MAX_TOTAL_BYTES_PER_MESSAGE) {
        result.skipped.push({ name, reason: 'over the 20 MB combined limit' });
        continue;
      }

      try {
        const [stored] = await storeAttachments(ticketId, [{ fileName: att.name || name, dataBase64: att.contentBytes }]);
        // storeAttachments also accepts an Outlook .eml (sniffed by header
        // shape, not extension), which a portal form allows on purpose -- but
        // here only pictures qualify, so a file named .png that turns out to
        // be one is discarded again.
        if (!/^image\//.test(stored.contentType)) {
          await deleteAttachments(ticketId, [stored]);
          result.skipped.push({ name, reason: 'not a valid PNG/JPG/GIF/WEBP image' });
          continue;
        }
        result.stored.push(stored);
        totalBytes += stored.size;
      } catch (e) {
        if (e instanceof AttachmentError) {
          result.skipped.push({ name, reason: 'not a valid PNG/JPG/GIF/WEBP image' });
        } else if (giveUp) {
          result.skipped.push({ name, reason: 'could not be saved' });
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    await deleteAttachments(ticketId, result.stored);
    throw e;
  }

  if (overLimit) result.skipped.push({ name: `${overLimit} more image${overLimit === 1 ? '' : 's'}`, reason: `only ${MAX_IMAGES} are imported per email` });
  if (unchecked) result.skipped.push({ name: `${unchecked} more attachment${unchecked === 1 ? '' : 's'}`, reason: `not checked -- more than ${MAX_FETCHES} images in one email` });
  return result;
}

// One line describing what was NOT imported, for the activity trail and the
// staff notification. Empty string when everything was.
function describeNotImported(result) {
  if (result.failed) return "this email's attachments could not be read from the mailbox";
  return result.skipped
    .slice(0, 10)
    .map((s) => `${String(s.name).slice(0, 80)} (${s.reason})`)
    .join('; ');
}

module.exports = { importEmailAttachments, describeNotImported, stripCidPlaceholders, referencesCid, looksLikeImage, MAX_IMAGES };
