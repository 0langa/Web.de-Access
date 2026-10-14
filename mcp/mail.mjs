import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { htmlToText } from "html-to-text";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import nodemailer from "nodemailer";

export function imapClientOptions(config) {
  return {
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    // Without implicit TLS, insist on STARTTLS. ImapFlow's default is
    // opportunistic: if the server (or anyone in between) does not offer
    // STARTTLS, it logs in with the app password in clear text.
    doSTARTTLS: config.imapSecure ? undefined : true,
    auth: {
      user: config.email,
      pass: config.password,
    },
    logger: false,
  };
}

export function createImapClient(config, extraOptions = {}) {
  const client = new ImapFlow({ ...imapClientOptions(config), ...extraOptions });
  // ImapFlow reports failures between commands (socket errors, timeouts,
  // malformed responses) as "error" events. Unhandled, Node turns that into
  // an uncaught exception that ends the whole MCP server; the command that
  // was waiting on the connection rejects on its own either way.
  client.on("error", () => {});
  return client;
}

export async function withImapConnection(config, work, extraOptions = {}) {
  const client = createImapClient(config, extraOptions);
  let connectionError = null;
  client.on("error", (error) => {
    connectionError ??= error;
  });

  await client.connect();
  try {
    return await work(client, config);
  } catch (error) {
    // A command interrupted by a dropped connection only reports that the
    // connection closed; keep the reason it closed.
    if (connectionError && error instanceof Error && error !== connectionError && !error.cause) {
      error.cause = connectionError;
    }
    throw error;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function checkConnection(client, config, { transport = getSmtpTransport(config) } = {}) {
  const mailboxes = await client.list();
  const folderChecks = {};

  for (const [key, mailbox] of Object.entries(config.folders)) {
    try {
      const status = await client.status(mailbox, {
        messages: true,
        unseen: true,
        uidNext: true,
        uidValidity: true,
      });
      // ImapFlow returns false, not an error, when the server refuses STATUS
      // for a folder that LIST still shows.
      if (!status) {
        throw new Error(`WEB.DE refused the status request for ${mailbox}.`);
      }
      folderChecks[key] = {
        mailbox,
        ok: true,
        messages: stringifyNumberLike(status.messages),
        unseen: stringifyNumberLike(status.unseen),
        uidNext: stringifyNumberLike(status.uidNext),
        uidValidity: stringifyNumberLike(status.uidValidity),
      };
    } catch (error) {
      folderChecks[key] = { mailbox, ok: false, error: describeError(error) };
    }
  }

  try {
    await transport.verify();
  } catch (error) {
    // Both libraries report timeouts and refused logins alike; say which side failed.
    throw new Error(
      `IMAP works, but the SMTP check at ${config.smtpHost}:${config.smtpPort} failed: ${describeError(error)}`,
    );
  }

  return {
    email: config.email,
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    imapSecure: config.imapSecure,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpSecure: config.smtpSecure,
    folders: folderChecks,
    availableMailboxes: mailboxes.map((mailbox) => mailbox.path),
  };
}

export async function withMailbox(client, mailbox, options, work) {
  await client.mailboxOpen(mailbox, options);
  try {
    return await work();
  } finally {
    await client.mailboxClose().catch(() => {});
  }
}

export function getSmtpTransport(config) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: !config.smtpSecure,
    auth: {
      user: config.email,
      pass: config.password,
    },
  });
}

export function fromAddress(config) {
  return config.defaultFromName ? `"${config.defaultFromName.replaceAll('"', '\\"')}" <${config.email}>` : config.email;
}

function isInsidePath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveFileAttachment(attachment, config) {
  const resolvedPath = path.resolve(attachment.path);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Attachment file does not exist: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Attachment path is not a file: ${resolvedPath}`);
  }
  if (stats.size > config.maxAttachmentBytes) {
    throw new Error(`Attachment exceeds the profile's maxAttachmentMb limit: ${resolvedPath}`);
  }

  const realPath = fs.realpathSync(resolvedPath);
  if (
    config.allowedAttachmentRoots.length &&
    !config.allowedAttachmentRoots.some((root) => isInsidePath(root, realPath))
  ) {
    throw new Error(`Attachment is outside the profile's allowedAttachmentRoots: ${resolvedPath}`);
  }

  return {
    path: realPath,
    filename: attachment.filename || path.basename(resolvedPath),
    contentType: attachment.contentType || undefined,
  };
}

export function buildOutgoingAttachments(inlineAttachments, fileAttachments, config) {
  const combined = [];

  for (const attachment of inlineAttachments || []) {
    if (Buffer.byteLength(attachment.content) > config.maxAttachmentBytes) {
      throw new Error(`Attachment exceeds the profile's maxAttachmentMb limit: ${attachment.filename}`);
    }
    combined.push({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType || undefined,
    });
  }

  for (const attachment of fileAttachments || []) {
    combined.push(resolveFileAttachment(attachment, config));
  }

  return combined.length ? combined : undefined;
}

export async function buildMessage({ from, to, cc, bcc, subject, text, html, replyTo, headers, attachments, messageId, keepBcc = false }) {
  const composer = new MailComposer({
    from,
    to,
    cc: cc?.length ? cc : undefined,
    bcc: bcc?.length ? bcc : undefined,
    replyTo: replyTo || undefined,
    subject,
    text,
    html: html || undefined,
    headers,
    attachments,
    messageId,
  });

  const compiled = composer.compile();
  compiled.keepBcc = keepBcc;
  return promisify(compiled.build.bind(compiled))();
}

export function stringifyNumberLike(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value ?? null;
}

export function describeError(error) {
  if (error && typeof error === "object") {
    const parts = [];
    if (typeof error.message === "string" && error.message.trim()) {
      parts.push(error.message.trim());
    }
    if (typeof error.responseText === "string" && error.responseText.trim()) {
      parts.push(error.responseText.trim());
    } else if (typeof error.response === "string" && error.response.trim()) {
      parts.push(error.response.trim());
    }
    if (error.cause && typeof error.cause === "object") {
      if (typeof error.cause.code === "string" && error.cause.code.trim()) {
        parts.push(error.cause.code.trim());
      }
      if (typeof error.cause.message === "string" && error.cause.message.trim()) {
        parts.push(error.cause.message.trim());
      }
    }
    return [...new Set(parts)].join(": ") || "Unknown error";
  }
  return String(error);
}

export function setToArray(value) {
  if (!value) {
    return [];
  }
  if (value instanceof Set) {
    return [...value];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function addressList(addresses) {
  return (addresses || [])
    .map((address) => ({
      name: address.name || "",
      address: address.address || "",
    }))
    .filter((address) => address.address);
}

export function parsedAddressList(addressObject) {
  return (addressObject?.value || [])
    .map((address) => ({
      name: address.name || "",
      address: address.address || "",
    }))
    .filter((address) => address.address);
}

export function firstAddress(addressObject) {
  return parsedAddressList(addressObject)[0]?.address || "";
}

function textFromHtml(html) {
  if (typeof html !== "string" || !html.trim()) {
    return "";
  }

  try {
    return htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ],
    }).trim();
  } catch {
    return html
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

export function parsedMessageText(parsed) {
  if (typeof parsed?.text === "string" && parsed.text.trim()) {
    return parsed.text;
  }

  return textFromHtml(parsed?.html || "");
}

export function parsedMessageTextSource(parsed) {
  if (typeof parsed?.text === "string" && parsed.text.trim()) {
    return "text";
  }
  if (typeof parsed?.html === "string" && parsed.html.trim()) {
    return "html";
  }
  return "none";
}

// ImapFlow passes the raw header text through when it cannot parse a date;
// toISOString() would throw on it and fail the whole search.
function isoDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function messageSummary(msg) {
  return {
    seq: msg.seq,
    uid: msg.uid,
    subject: msg.envelope?.subject || "",
    messageId: msg.envelope?.messageId || "",
    inReplyTo: msg.envelope?.inReplyTo || "",
    date: isoDate(msg.envelope?.date),
    internalDate: isoDate(msg.internalDate),
    from: addressList(msg.envelope?.from),
    to: addressList(msg.envelope?.to),
    cc: addressList(msg.envelope?.cc),
    flags: setToArray(msg.flags),
    size: msg.size ?? null,
    attachments: collectAttachmentParts(msg.bodyStructure),
  };
}

function collectAttachmentParts(node, parts = []) {
  if (!node) {
    return parts;
  }

  const disposition = (node.disposition || "").toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name || "";
  const type = (node.type || "").toLowerCase();
  const isDisplayBody = type === "text/plain" || type === "text/html";
  const isAttachment = Boolean(node.part && (disposition === "attachment" || filename || (!isDisplayBody && !node.childNodes?.length)));

  if (isAttachment) {
    parts.push({
      part: node.part,
      filename: filename || defaultPartFilename(node),
      contentType: node.type || "application/octet-stream",
      size: node.size ?? null,
      disposition: node.disposition || "",
    });
  }

  for (const child of node.childNodes || []) {
    collectAttachmentParts(child, parts);
  }

  return parts;
}

function defaultPartFilename(node) {
  const extensionByType = {
    "text/calendar": ".ics",
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "text/html": ".html",
  };
  const extension = extensionByType[(node.type || "").toLowerCase()] || "";
  return `part-${node.part}${extension}`;
}

// IMAP SEARCH compares whole days. ImapFlow parses a date string with
// new Date() and silently drops a criterion it cannot parse, which turns a
// filtered search into one over every message. Only YYYY-MM-DD is accepted:
// it parses as UTC midnight, the day ImapFlow sends, while other formats are
// read in local time and can move the search by a day.
export function isImapSearchDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function isUidSet(value) {
  return value.split(",").every((range) => /^(\d+|\*)(:(\d+|\*))?$/.test(range));
}

export function isBodyPartNumber(value) {
  return /^\d+(\.\d+)*$/.test(value);
}

export function buildSearchObject(input, options = {}) {
  const omit = new Set(options.omit || []);
  const query = {};
  if (input.unseen) query.seen = false;
  if (input.seen) query.seen = true;
  if (input.flagged) query.flagged = true;
  if (input.from) query.from = input.from;
  if (input.to) query.to = input.to;
  if (input.cc) query.cc = input.cc;
  if (input.subject && !omit.has("subject")) query.subject = input.subject;
  if (input.text) query.text = input.text;
  if (input.body) query.body = input.body;
  if (input.since) query.since = input.since;
  if (input.before) query.before = input.before;
  if (input.on) query.on = input.on;
  if (input.uid) query.uid = input.uid;
  return Object.keys(query).length ? query : { all: true };
}

// Collapses consecutive UIDs into IMAP ranges ("1:500,502").
export function packUidSet(uids) {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    while (sorted[index + 1] === sorted[index] + 1) {
      index += 1;
    }
    ranges.push(start === sorted[index] ? String(start) : `${start}:${sorted[index]}`);
  }
  return ranges.join(",");
}

// A subject search fetches the envelope of every candidate, for a subject-only
// search that is the whole mailbox. ImapFlow sends a UID array as one
// comma-separated list, so batch and pack the UIDs to keep each command line
// within the ~8000 octets RFC 2683 asks servers to accept.
const SUBJECT_FETCH_BATCH = 500;

export async function filterIdsBySubject(client, ids, subject) {
  if (!subject || !ids.length) {
    return ids;
  }

  const needle = subject.toLocaleLowerCase();
  const matched = [];
  for (let start = 0; start < ids.length; start += SUBJECT_FETCH_BATCH) {
    for await (const msg of client.fetch(
      packUidSet(ids.slice(start, start + SUBJECT_FETCH_BATCH)),
      {
        uid: true,
        envelope: true,
      },
      { uid: true },
    )) {
      if ((msg.envelope?.subject || "").toLocaleLowerCase().includes(needle)) {
        matched.push(msg.uid);
      }
    }
  }
  return matched;
}

export function normalizeLimit(limit, fallback) {
  if (!limit) {
    return fallback;
  }
  return Math.max(1, Math.min(limit, 500));
}

export async function fetchParsedMessage(client, mailbox, uid, config) {
  return withMailbox(client, mailbox, { readOnly: !config.markReadOnFetch }, async () => {
    const msg = await client.fetchOne(
      String(uid),
      {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true,
        bodyStructure: true,
        // One byte over the limit tells a message that fits exactly from one
        // that was cut off, independent of the size the server reports.
        source: { maxLength: config.maxSourceBytes + 1 },
      },
      { uid: true },
    );

    if (!msg) {
      throw new Error(`Message UID ${uid} was not found in ${mailbox}.`);
    }

    // ImapFlow always fetches with BODY.PEEK, so reading alone never sets
    // \Seen; markReadOnFetch has to set it explicitly.
    if (config.markReadOnFetch) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      msg.flags = new Set([...(msg.flags || []), "\\Seen"]);
    }

    const source = msg.source || Buffer.alloc(0);
    // A cut-off source still parses, but its later parts and attachments are
    // missing or incomplete.
    const truncated = source.length > config.maxSourceBytes || Number(msg.size) > config.maxSourceBytes;
    const parsed = await simpleParser(truncated ? source.subarray(0, config.maxSourceBytes) : source);
    return { msg, parsed, truncated };
  });
}

// Same tests ImapFlow uses: IMAP4rev2 includes both MOVE and UIDPLUS.
function isRev2Session(client) {
  return client.enabled.has("IMAP4REV2") || (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"));
}

// UID EXPUNGE comes with UIDPLUS.
function canExpungeByUid(client) {
  return client.capabilities.has("UIDPLUS") || isRev2Session(client);
}

function uidMapOf(result) {
  return result?.uidMap ? Object.fromEntries(result.uidMap) : null;
}

// ImapFlow resolves a failed STORE, COPY, MOVE or EXPUNGE to false instead of
// rejecting, so every mutation below checks the result before it reports
// success.
export async function markMessages(client, { mailbox, uids, action }) {
  const flag = action === "read" || action === "unread" ? "\\Seen" : "\\Flagged";
  const add = action === "read" || action === "star";
  const ok = add
    ? await client.messageFlagsAdd(uids, [flag], { uid: true })
    : await client.messageFlagsRemove(uids, [flag], { uid: true });
  if (!ok) {
    throw new Error(`WEB.DE did not confirm marking the messages in ${mailbox} as ${action}.`);
  }
  return { mailbox, uids, action, ok };
}

export async function copyMessages(client, { sourceMailbox, destinationMailbox, uids }) {
  const result = await client.messageCopy(uids, destinationMailbox, { uid: true });
  if (!result) {
    throw new Error(
      `WEB.DE did not copy the messages from ${sourceMailbox} to ${destinationMailbox}. Check the folder name with list_webde_mailboxes.`,
    );
  }
  return { sourceMailbox, destinationMailbox, uids, uidMap: uidMapOf(result) };
}

async function expungeByUid(client, mailbox, uids) {
  const ok = await client.messageDelete(uids, { uid: true });
  if (!ok) {
    // ImapFlow flags the messages \Deleted before it expunges. Left flagged,
    // the next EXPUNGE from any mail client would remove them after all.
    const restored = await client.messageFlagsRemove(uids, ["\\Deleted"], { uid: true }).catch(() => false);
    throw new Error(
      `WEB.DE did not confirm the expunge in ${mailbox}; ${
        restored ? "the messages were left in place" : "the messages may still be flagged as deleted"
      }.`,
    );
  }
}

export async function moveMessages(client, { sourceMailbox, destinationMailbox, uids }) {
  let result;
  if (client.capabilities.has("MOVE") || isRev2Session(client)) {
    result = await client.messageMove(uids, destinationMailbox, { uid: true });
  } else {
    // ImapFlow emulates a missing MOVE as COPY plus delete, but deletes the
    // originals even when the copy failed, and expunges the whole mailbox
    // without UIDPLUS. Take the steps here and stop after a failed copy.
    if (!canExpungeByUid(client)) {
      throw new Error(
        `Refusing to move: the IMAP server supports neither MOVE nor UIDPLUS, so removing the originals would also expunge other messages marked as deleted in ${sourceMailbox}. Copy the messages instead.`,
      );
    }
    result = await client.messageCopy(uids, destinationMailbox, { uid: true });
    if (result) {
      await expungeByUid(client, sourceMailbox, uids);
    }
  }
  if (!result) {
    throw new Error(
      `WEB.DE did not move the messages from ${sourceMailbox} to ${destinationMailbox}. Check the folder name with list_webde_mailboxes.`,
    );
  }
  return { sourceMailbox, destinationMailbox, uids, uidMap: uidMapOf(result) };
}

export async function deleteMessages(client, config, { mailbox, uids, permanent }) {
  if (permanent) {
    // Without UID EXPUNGE, ImapFlow falls back to a plain EXPUNGE, which
    // permanently removes every message flagged \Deleted in the mailbox, also
    // ones other mail clients only marked, not just these UIDs.
    if (!canExpungeByUid(client)) {
      throw new Error(
        `Refusing to delete permanently: the IMAP server does not support UIDPLUS, so the expunge would also remove other messages marked as deleted in ${mailbox}. Move the messages to ${config.folders.trash} instead.`,
      );
    }
    await expungeByUid(client, mailbox, uids);
    return { mailbox, uids, permanent: true, ok: true };
  }

  const moved = await moveMessages(client, { sourceMailbox: mailbox, destinationMailbox: config.folders.trash, uids });
  return {
    mailbox,
    trashMailbox: config.folders.trash,
    uids,
    permanent: false,
    uidMap: moved.uidMap,
  };
}

const systemMailboxes = ["INBOX", "Gesendet", "Entwurf", "Entwürfe", "Papierkorb", "Spam", "Postausgang"];

// Refuses WEB.DE's system folders and every folder the profile maps (sent,
// drafts, trash, ...), whatever they are called in this account. INBOX is
// case-insensitive in IMAP, and a trailing hierarchy delimiter names the same
// folder.
export function assertDeletableMailbox(mailbox, config) {
  const name = mailbox.replace(/\/+$/, "");
  const protectedNames = new Set([...systemMailboxes, ...Object.values(config.folders || {})]);
  if (name.toUpperCase() === "INBOX" || protectedNames.has(name)) {
    throw new Error(`Refusing to delete protected mailbox: ${mailbox}`);
  }
}

export function sanitizeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim() || "attachment";
}

export function ensureInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside attachment directory: ${child}`);
  }
}

export function uniqueFilePath(directory, filename) {
  const parsed = path.parse(sanitizeFilename(filename));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

export function defaultDownloadFilename(uid, part, contentType) {
  const extensionByType = {
    "text/calendar": ".ics",
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "text/html": ".html",
    "message/rfc822": ".eml",
  };
  const extension = extensionByType[(contentType || "").toLowerCase()] || "";
  return `message-${uid}-part-${part}${extension}`;
}

export function formatLimit(bytes) {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${bytes} bytes`;
}

// ImapFlow ends a download at maxBytes without reporting that it did. Callers
// request one byte more than they allow, so a file that reaches that byte was
// cut off; it is removed instead of being returned as if it were complete.
async function saveDownload(content, outputPath, maxBytes, tooLargeMessage) {
  // "wx" never replaces a file that appeared after uniqueFilePath() chose the name.
  const output = fs.createWriteStream(outputPath, { flags: "wx" });
  let created = false;
  output.once("open", () => {
    created = true;
  });
  try {
    await pipeline(content, output);
    const size = fs.statSync(outputPath).size;
    if (size > maxBytes) {
      throw new Error(tooLargeMessage);
    }
    return size;
  } catch (error) {
    if (created) {
      fs.rmSync(outputPath, { force: true });
    }
    throw error;
  }
}

export async function exportMessage(client, config, { mailbox, uid, filename }) {
  fs.mkdirSync(config.attachmentDownloadDir, { recursive: true });
  const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, size: true }, { uid: true });
  if (!msg) {
    throw new Error(`Message UID ${uid} was not found in ${mailbox}.`);
  }

  const tooLarge = `Message UID ${uid} in ${mailbox} is larger than the profile's maxSourceMb limit (${formatLimit(
    config.maxSourceBytes,
  )}), so it cannot be exported completely. Raise maxSourceMb in the profile to export it.`;
  if (Number(msg.size) > config.maxSourceBytes) {
    throw new Error(tooLarge);
  }

  const { meta, content } = await client.download(String(uid), undefined, {
    uid: true,
    maxBytes: config.maxSourceBytes + 1,
  });
  if (!content) {
    throw new Error(`Message UID ${uid} was not found in ${mailbox}.`);
  }
  const subject = msg.envelope?.subject ? sanitizeFilename(msg.envelope.subject).slice(0, 80) : `message-${uid}`;
  const outputPath = uniqueFilePath(config.attachmentDownloadDir, filename || `${subject}-${uid}.eml`);
  ensureInside(config.attachmentDownloadDir, outputPath);
  const size = await saveDownload(content, outputPath, config.maxSourceBytes, tooLarge);

  return {
    mailbox,
    uid,
    outputPath,
    filename: path.basename(outputPath),
    contentType: meta.contentType || "message/rfc822",
    size,
    expectedSize: meta.expectedSize ?? null,
  };
}

export async function downloadAttachment(client, config, { mailbox, uid, part, filename }) {
  fs.mkdirSync(config.attachmentDownloadDir, { recursive: true });
  const { meta, content } = await client.download(String(uid), part, {
    uid: true,
    maxBytes: config.maxAttachmentBytes + 1,
  });
  if (!content) {
    throw new Error(`Part ${part} of message UID ${uid} was not found in ${mailbox}.`);
  }
  const outputPath = uniqueFilePath(
    config.attachmentDownloadDir,
    filename || meta.filename || defaultDownloadFilename(uid, part, meta.contentType),
  );
  ensureInside(config.attachmentDownloadDir, outputPath);
  const downloadedSize = await saveDownload(
    content,
    outputPath,
    config.maxAttachmentBytes,
    `Attachment part ${part} of message UID ${uid} is larger than the profile's maxAttachmentMb limit (${formatLimit(
      config.maxAttachmentBytes,
    )}). Raise maxAttachmentMb in the profile to download it.`,
  );

  return {
    mailbox,
    uid,
    part,
    outputPath,
    filename: path.basename(outputPath),
    contentType: meta.contentType || "application/octet-stream",
    size: downloadedSize,
    expectedSize: downloadedSize,
  };
}

export function replyRecipients(parsed, config, replyAll) {
  const own = config.email.toLowerCase();
  const seen = new Set();
  const add = (list) => {
    const recipients = [];
    for (const item of list) {
      const address = item.address?.trim();
      if (!address || address.toLowerCase() === own || seen.has(address.toLowerCase())) {
        continue;
      }
      seen.add(address.toLowerCase());
      recipients.push(address);
    }
    return recipients;
  };

  const primary = parsedAddressList(parsed.replyTo).length ? parsedAddressList(parsed.replyTo) : parsedAddressList(parsed.from);
  const to = add(primary);
  const cc = replyAll ? add([...parsedAddressList(parsed.to), ...parsedAddressList(parsed.cc)]) : [];
  return { to, cc };
}

export function prefixedSubject(subject, prefix) {
  const clean = subject || "";
  return clean.toLowerCase().startsWith(`${prefix.toLowerCase()}:`) ? clean : `${prefix}: ${clean}`.trim();
}

export function quoteOriginal(parsed) {
  const from = firstAddress(parsed.from) || "unknown sender";
  const date = parsed.date ? new Date(parsed.date).toISOString() : "unknown date";
  const body = parsedMessageText(parsed);
  return `\n\nOn ${date}, ${from} wrote:\n${body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")}`;
}

const htmlEntities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => htmlEntities[char]);
}

function textToHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>\n");
}

// Mail clients show the HTML part of a multipart/alternative message, so a
// quote or forwarded message that exists only in the text part never reaches
// most recipients. Add it before </body> when the caller sent a full document.
function appendToHtml(html, addition) {
  const bodyEnd = html.search(/<\/body\s*>/i);
  return bodyEnd < 0 ? `${html}${addition}` : `${html.slice(0, bodyEnd)}${addition}${html.slice(bodyEnd)}`;
}

function quoteOriginalHtml(parsed) {
  const from = firstAddress(parsed.from) || "unknown sender";
  const date = parsed.date ? new Date(parsed.date).toISOString() : "unknown date";
  return `<br>\n<br>\n<div>On ${escapeHtml(date)}, ${escapeHtml(from)} wrote:</div>\n<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(
    parsedMessageText(parsed),
  )}</blockquote>`;
}

export async function replyToMessage(client, config, input, sendOptions) {
  const { mailbox, uid, text, html, replyAll, includeOriginal, cc, bcc, attachments, fileAttachments, saveSentCopy } = input;
  const { parsed } = await fetchParsedMessage(client, mailbox, uid, config);
  const recipients = replyRecipients(parsed, config, replyAll);
  if (!recipients.to.length) {
    throw new Error("No reply recipient could be inferred from the original message.");
  }

  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const messageId = parsed.messageId || "";
  const result = await sendMailAndMaybeSaveSent(
    config,
    {
      to: recipients.to,
      cc: [...recipients.cc, ...(cc || [])],
      bcc,
      subject: prefixedSubject(parsed.subject, "Re"),
      text: `${text}${includeOriginal ? quoteOriginal(parsed) : ""}`,
      html: html && includeOriginal ? appendToHtml(html, quoteOriginalHtml(parsed)) : html,
      attachments,
      fileAttachments,
      saveSentCopy,
      headers: {
        ...(messageId ? { "In-Reply-To": messageId } : {}),
        ...(references.length || messageId ? { References: [...references, messageId].filter(Boolean).join(" ") } : {}),
      },
    },
    sendOptions,
  );

  return {
    original: { mailbox, uid, subject: parsed.subject || "" },
    to: recipients.to,
    cc: [...recipients.cc, ...(cc || [])],
    ...result,
  };
}

export async function forwardMessage(client, config, input, sendOptions) {
  const { mailbox, uid, to, text, html, cc, bcc, includeOriginalAttachments, attachments, fileAttachments, saveSentCopy } = input;
  const { parsed, truncated } = await fetchParsedMessage(client, mailbox, uid, config);
  if (includeOriginalAttachments && truncated) {
    throw new Error(
      `Message UID ${uid} in ${mailbox} is larger than the profile's maxSourceMb limit (${formatLimit(
        config.maxSourceBytes,
      )}), so its attachments cannot be forwarded intact. Raise maxSourceMb in the profile, or forward it without includeOriginalAttachments.`,
    );
  }
  const originalAttachments = includeOriginalAttachments
    ? (parsed.attachments || []).map((attachment, index) => ({
        filename: attachment.filename || `forwarded-attachment-${index + 1}`,
        content: attachment.content,
        contentType: attachment.contentType || undefined,
      }))
    : [];

  const forwardedBlock = `---------- Forwarded message ---------\nFrom: ${firstAddress(parsed.from)}\nDate: ${
    parsed.date ? new Date(parsed.date).toISOString() : ""
  }\nSubject: ${parsed.subject || ""}\nTo: ${parsedAddressList(parsed.to)
    .map((address) => address.address)
    .join(", ")}\n\n${parsedMessageText(parsed)}`;

  const result = await sendMailAndMaybeSaveSent(
    config,
    {
      to,
      cc,
      bcc,
      subject: prefixedSubject(parsed.subject, "Fwd"),
      text: `${text || ""}\n\n${forwardedBlock}`,
      html: html ? appendToHtml(html, `<br>\n<br>\n${textToHtml(forwardedBlock)}`) : html,
      attachments: [...(attachments || []), ...originalAttachments],
      fileAttachments,
      saveSentCopy,
    },
    sendOptions,
  );

  return {
    original: { mailbox, uid, subject: parsed.subject || "" },
    to,
    includedOriginalAttachments: originalAttachments.length,
    ...result,
  };
}

export async function sendMailAndMaybeSaveSent(config, message, { transport = getSmtpTransport(config), imapOptions } = {}) {
  const attachments = buildOutgoingAttachments(message.attachments, message.fileAttachments, config);
  const messageId = `<${globalThis.crypto.randomUUID()}@web.de>`;
  const mail = {
    from: fromAddress(config),
    to: message.to,
    cc: message.cc?.length ? message.cc : undefined,
    bcc: message.bcc?.length ? message.bcc : undefined,
    replyTo: message.replyTo || undefined,
    subject: message.subject,
    text: message.text,
    html: message.html || undefined,
    headers: message.headers,
    attachments,
    messageId,
  };

  const result = await transport.sendMail(mail);
  let sentCopy = null;

  if (message.saveSentCopy ?? config.saveSentCopy) {
    // The message has been handed to SMTP at this point. Reporting a failed
    // Sent copy as a failed send would invite a retry that sends it twice.
    try {
      const raw = await buildMessage({ ...mail, keepBcc: true });
      const appended = await withImapConnection(
        config,
        (client) => client.append(config.folders.sent, raw, ["\\Seen"]),
        imapOptions,
      );
      if (!appended) {
        throw new Error("WEB.DE did not confirm the append request.");
      }
      sentCopy = {
        mailbox: config.folders.sent,
        uid: stringifyNumberLike(appended.uid),
        uidValidity: stringifyNumberLike(appended.uidValidity),
      };
    } catch (error) {
      sentCopy = { mailbox: config.folders.sent, uid: null, uidValidity: null, error: describeError(error) };
    }
  }

  return {
    messageId: result.messageId ?? null,
    accepted: result.accepted ?? [],
    rejected: result.rejected ?? [],
    response: result.response ?? null,
    sentCopy,
  };
}

// Appended to the tool's text result so a caller cannot mistake a missing
// Sent copy for a failed send.
export function sentCopyWarning(result) {
  return result.sentCopy?.error
    ? ` The message was sent, but its copy could not be saved to ${result.sentCopy.mailbox}: ${result.sentCopy.error}`
    : "";
}
