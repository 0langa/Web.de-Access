import fs from "node:fs";
import path from "node:path";
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
    throw new Error(`Attachment exceeds WEBDE_MAX_ATTACHMENT_MB: ${resolvedPath}`);
  }

  const realPath = fs.realpathSync(resolvedPath);
  if (
    config.allowedAttachmentRoots.length &&
    !config.allowedAttachmentRoots.some((root) => isInsidePath(root, realPath))
  ) {
    throw new Error(`Attachment is outside WEBDE_ALLOWED_ATTACHMENT_ROOTS: ${resolvedPath}`);
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
      throw new Error(`Attachment exceeds WEBDE_MAX_ATTACHMENT_MB: ${attachment.filename}`);
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

export function messageSummary(msg) {
  return {
    seq: msg.seq,
    uid: msg.uid,
    subject: msg.envelope?.subject || "",
    messageId: msg.envelope?.messageId || "",
    inReplyTo: msg.envelope?.inReplyTo || "",
    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
    internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
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

export async function filterIdsBySubject(client, ids, subject) {
  if (!subject || !ids.length) {
    return ids;
  }

  const needle = subject.toLocaleLowerCase();
  const matched = [];
  for await (const msg of client.fetch(
    ids,
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
        source: { maxLength: config.maxSourceBytes },
      },
      { uid: true },
    );

    if (!msg) {
      throw new Error(`Message UID ${uid} was not found in ${mailbox}.`);
    }

    const parsed = await simpleParser(msg.source || Buffer.alloc(0));
    return { msg, parsed };
  });
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

export async function sendMailAndMaybeSaveSent(config, message) {
  const attachments = buildOutgoingAttachments(message.attachments, message.fileAttachments, config);
  const transport = getSmtpTransport(config);
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
  let sentAppend = null;

  if (message.saveSentCopy ?? config.saveSentCopy) {
    const raw = await buildMessage({ ...mail, keepBcc: true });
    sentAppend = await withImapConnection(config, (client) => client.append(config.folders.sent, raw, ["\\Seen"]));
  }

  return {
    messageId: result.messageId ?? null,
    accepted: result.accepted ?? [],
    rejected: result.rejected ?? [],
    response: result.response ?? null,
    sentCopy: sentAppend
      ? {
          mailbox: config.folders.sent,
          uid: stringifyNumberLike(sentAppend.uid),
          uidValidity: stringifyNumberLike(sentAppend.uidValidity),
        }
      : null,
  };
}
