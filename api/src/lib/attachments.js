const crypto = require('crypto');
const { BlobServiceClient } = require('@azure/storage-blob');

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = 'attachments';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const MAX_EML_BYTES = 20 * 1024 * 1024; // 20 MB per .eml -- a forwarded email can carry its own attachments
const MAX_FILES_PER_MESSAGE = 5; // up to 4 images plus 1 forwarded email
const MAX_TOTAL_BYTES_PER_MESSAGE = 20 * 1024 * 1024; // guard against many files each near the per-file cap
// Headroom over MAX_TOTAL_BYTES_PER_MESSAGE for base64 inflation (~4/3x --
// 20MB decoded is ~26.7MB of base64) plus the rest of the JSON payload
// (name/subject/description/etc) -- checked against Content-Length BEFORE
// the body is read/parsed, so an oversized request is rejected without
// ever buffering it into memory. Azure Static Web Apps caps the whole
// request around 30MB regardless, so this stays comfortably under that.
const MAX_REQUEST_BODY_BYTES = 28 * 1024 * 1024;

// image/svg+xml is deliberately not in this list -- an SVG can carry
// embedded <script>, making it an XSS vector if ever rendered or linked
// to directly, which is exactly what attachment viewing does.
const EXT_TO_TYPE = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', eml: 'message/rfc822' };
const ATTACHMENT_ID_RE = /^[0-9a-f]{24}\.(png|jpg|gif|webp|eml)$/;
// .eml is never served inline (see dispositionFor below) -- unlike an image,
// its body can contain HTML/script, so it's always forced to download
// rather than risk a browser attempting to render it.
const INLINE_EXTS = new Set(['png', 'jpg', 'gif', 'webp']);

let containerClient;
let ensured;

function getContainerClient() {
  if (!containerClient) {
    if (!CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
    containerClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING).getContainerClient(CONTAINER_NAME);
  }
  return containerClient;
}

// Created with no `access` option, which the REST API treats as fully
// private (no anonymous read) -- attachments are only ever served back
// through our own authenticated/token-checked download endpoints, never
// a direct blob URL.
async function ensureContainer() {
  if (!ensured) {
    ensured = getContainerClient()
      .createIfNotExists()
      .catch((e) => {
        ensured = null; // allow a retry on the next call instead of caching a failure forever
        throw e;
      });
  }
  return ensured;
}

class AttachmentError extends Error {}

// Checked before request.json() ever reads/parses the body, so an
// oversized request is rejected on the Content-Length header alone --
// otherwise a huge body would be fully buffered and JSON-parsed in memory
// before any of the size checks below could ever run. Returns a ready-made
// 413 response, or null if the request should proceed.
function rejectIfTooLarge(request) {
  const len = parseInt(request.headers.get('content-length') || '', 10);
  if (len > MAX_REQUEST_BODY_BYTES) {
    return { status: 413, jsonBody: { error: 'Request is too large.' } };
  }
  return null;
}

// Classifies by the actual file bytes, never the client-declared content
// type (which is attacker-controlled input) -- a request claiming
// "image/png" for an HTML/JS payload is rejected here regardless of what
// header or field it arrived with.
function sniffImageType(buf) {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return { contentType: 'image/gif', ext: 'gif' };
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  return null;
}

// A forwarded Outlook .eml is just an RFC 822 message: a block of header
// lines (From/To/Subject/Date/...) followed by a blank line, then the body.
// There's no magic-byte signature to check like the image formats above, so
// this looks for that header/blank-line shape in the first 8KB instead --
// loose by design, since the real security boundary is serving it back with
// a forced download rather than inline (see dispositionFor/INLINE_EXTS
// above), not a strict RFC 822 parse. Just enough to reject an unrelated
// file that happens to be renamed to .eml.
const EML_HEADER_RE = /^(From|To|Cc|Subject|Date|Received|Message-ID|MIME-Version|Content-Type):/im;
function looksLikeEmlFile(buf) {
  const head = buf.subarray(0, 8192).toString('utf8');
  const blankLineIdx = head.search(/\r?\n\r?\n/);
  const headerBlock = blankLineIdx === -1 ? head : head.slice(0, blankLineIdx);
  return EML_HEADER_RE.test(headerBlock);
}

// 'inline' for images (rendered directly in the browser, as today);
// 'attachment' (forced download) for everything else -- currently just
// .eml, whose body can carry HTML/script, unlike a sniffed image/*.
function dispositionFor(attachmentId) {
  const ext = attachmentId.slice(attachmentId.lastIndexOf('.') + 1).toLowerCase();
  return INLINE_EXTS.has(ext) ? 'inline' : 'attachment';
}

// Validates and stores one client-submitted attachment. `raw` is
// { fileName, dataBase64 }. Returns metadata only -- no raw bytes -- for
// embedding in the message entity/API response.
async function storeAttachment(ticketId, raw) {
  const base64 = String((raw && raw.dataBase64) || '');
  // Cheap pre-check before the decode: base64 runs ~4/3 the size of the
  // decoded bytes, so this rejects grossly oversized payloads up front.
  // Uses the larger (.eml) cap here since the type isn't known yet -- the
  // type-specific cap below is what actually enforces the image limit.
  if (base64.length > MAX_EML_BYTES * 1.4) {
    throw new AttachmentError('Each attachment must be 20 MB or smaller.');
  }

  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new AttachmentError('An attachment was empty.');

  // Classified by the actual bytes, never the client-declared type or
  // filename extension (both attacker-controlled) -- same principle as the
  // image sniffing this builds on.
  let sniffed = sniffImageType(buf);
  if (sniffed) {
    if (buf.length > MAX_FILE_BYTES) throw new AttachmentError('Each image must be 10 MB or smaller.');
  } else if (looksLikeEmlFile(buf)) {
    if (buf.length > MAX_EML_BYTES) throw new AttachmentError('The .eml file must be 20 MB or smaller.');
    sniffed = { contentType: 'message/rfc822', ext: 'eml' };
  } else {
    throw new AttachmentError('Only PNG, JPEG, GIF, WEBP images or an Outlook .eml file are allowed.');
  }

  const id = `${crypto.randomBytes(12).toString('hex')}.${sniffed.ext}`;
  await ensureContainer();
  await getContainerClient()
    .getBlockBlobClient(`${ticketId}/${id}`)
    .uploadData(buf, { blobHTTPHeaders: { blobContentType: sniffed.contentType } });

  const fileName = String((raw && raw.fileName) || 'image').trim().slice(0, 150) || 'image';
  return { id, fileName, contentType: sniffed.contentType, size: buf.length };
}

// Best-effort delete -- an orphaned blob is a storage-cost/hygiene issue,
// not a security one, so a failed cleanup here must never mask or replace
// whatever original error triggered it.
async function deleteBlob(ticketId, id) {
  try {
    await ensureContainer();
    await getContainerClient().getBlockBlobClient(`${ticketId}/${id}`).deleteIfExists();
  } catch (e) {
    // swallow -- see comment above
  }
}

// Deletes a set of already-stored attachments (as returned by
// storeAttachments). Exposed for callers that store attachments
// successfully but then fail a later step (e.g. the Table Storage writes
// that actually attach them to a ticket/message), so those blobs don't
// outlive the ticket/message that was supposed to reference them.
async function deleteAttachments(ticketId, attachments) {
  await Promise.all((attachments || []).map((a) => deleteBlob(ticketId, a.id)));
}

// Wipes every blob under a ticket's prefix in one pass, rather than
// collecting attachment ids from the meta row plus every message -- blobs
// are always stored at `${ticketId}/${id}`, so a prefix listing is a
// complete and simpler picture of what belongs to the ticket. Used only when
// the whole ticket is being deleted; best-effort like deleteBlob above,
// since by the time this runs the ticket's Table Storage rows are already
// gone and an orphaned blob is just a storage-hygiene issue, not a
// correctness or security one.
async function deleteAllAttachmentsForTicket(ticketId) {
  try {
    await ensureContainer();
    const container = getContainerClient();
    for await (const blob of container.listBlobsFlat({ prefix: `${ticketId}/` })) {
      await container.getBlockBlobClient(blob.name).deleteIfExists();
    }
  } catch (e) {
    // swallow -- see comment above
  }
}

// `rawList` is whatever the client sent as `attachments` on a ticket
// create/reply request. Validated as a whole (count + combined size)
// BEFORE any individual file is uploaded, so an oversized/over-count
// request fails fast without uploading anything. If a LATER file in the
// same batch fails once uploading is under way, the earlier files already
// stored in this call are cleaned up before the error propagates, rather
// than left as permanent orphans.
async function storeAttachments(ticketId, rawList) {
  if (rawList == null) return [];
  if (!Array.isArray(rawList)) throw new AttachmentError('Invalid attachments.');
  if (rawList.length > MAX_FILES_PER_MESSAGE) {
    throw new AttachmentError(`Attach at most ${MAX_FILES_PER_MESSAGE} files per message.`);
  }
  const approxTotalBytes = rawList.reduce((sum, r) => sum + String((r && r.dataBase64) || '').length * 0.75, 0);
  if (approxTotalBytes > MAX_TOTAL_BYTES_PER_MESSAGE) {
    throw new AttachmentError('Attachments are too large combined (max 20 MB total).');
  }

  const stored = [];
  try {
    for (const raw of rawList) {
      stored.push(await storeAttachment(ticketId, raw));
    }
  } catch (e) {
    await deleteAttachments(ticketId, stored);
    throw e;
  }
  return stored;
}

// Blob names are always server-generated (random hex + a whitelisted
// extension), so this is not a real path-traversal vector, but the format
// is still validated since attachmentId ultimately comes from a URL segment.
async function downloadAttachment(ticketId, attachmentId) {
  if (!ATTACHMENT_ID_RE.test(attachmentId)) return null;
  const ext = attachmentId.slice(attachmentId.lastIndexOf('.') + 1);
  await ensureContainer();
  try {
    const buffer = await getContainerClient().getBlockBlobClient(`${ticketId}/${attachmentId}`).downloadToBuffer();
    return { buffer, contentType: EXT_TO_TYPE[ext] };
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

// Used only by ticket merging -- copies one attachment's bytes to a new
// blob under a DIFFERENT ticket's prefix (with a freshly generated id, same
// as any other upload) and returns its new metadata, so a merged message's
// image keeps working instead of pointing at a blob that's about to be
// deleted along with the rest of the source ticket. A plain download +
// re-upload rather than a server-side blob copy -- merges are rare and
// staff-initiated, not a hot path, and this avoids the SAS-token machinery
// a same-account copy between two private containers would otherwise need.
async function copyAttachmentToTicket(sourceTicketId, attachment, destTicketId) {
  if (!ATTACHMENT_ID_RE.test(attachment.id)) throw new Error('Invalid source attachment id');
  await ensureContainer();
  const buffer = await getContainerClient().getBlockBlobClient(`${sourceTicketId}/${attachment.id}`).downloadToBuffer();
  const ext = attachment.id.slice(attachment.id.lastIndexOf('.') + 1);
  const id = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await getContainerClient()
    .getBlockBlobClient(`${destTicketId}/${id}`)
    .uploadData(buffer, { blobHTTPHeaders: { blobContentType: attachment.contentType } });
  return { id, fileName: attachment.fileName, contentType: attachment.contentType, size: buffer.length };
}

function parseAttachments(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

module.exports = {
  storeAttachments,
  deleteAttachments,
  deleteAllAttachmentsForTicket,
  downloadAttachment,
  copyAttachmentToTicket,
  parseAttachments,
  rejectIfTooLarge,
  dispositionFor,
  AttachmentError,
  MAX_FILE_BYTES,
  MAX_EML_BYTES,
  MAX_FILES_PER_MESSAGE,
};
