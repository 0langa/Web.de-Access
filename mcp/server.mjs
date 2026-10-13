import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { loadRuntimeConfig } from "./auth-config.mjs";
import {
  buildMessage,
  buildOutgoingAttachments,
  buildSearchObject,
  defaultDownloadFilename,
  describeError,
  ensureInside,
  fetchParsedMessage,
  filterIdsBySubject,
  firstAddress,
  fromAddress,
  getSmtpTransport,
  messageSummary,
  normalizeLimit,
  parsedAddressList,
  parsedMessageText,
  parsedMessageTextSource,
  prefixedSubject,
  quoteOriginal,
  replyRecipients,
  sanitizeFilename,
  sendMailAndMaybeSaveSent,
  setToArray,
  stringifyNumberLike,
  uniqueFilePath,
  withImapConnection,
  withMailbox,
} from "./mail.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));

const server = new McpServer({
  name: "webde-access",
  version,
  instructions:
    "Use this server for private WEB.DE mailbox access via IMAP and SMTP: list folders, search/read mail, manage messages, create drafts, send, reply, forward, and save attachments.",
});

async function withImapClient(work) {
  const config = await loadRuntimeConfig({ pluginRoot });
  return withImapConnection(config, work);
}

function makeTextResult(message, structuredContent = undefined) {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    structuredContent,
  };
}

function makeJsonSafe(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Set) {
    return [...value].map(makeJsonSafe);
  }
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, item]) => [key, makeJsonSafe(item)]));
  }
  if (Array.isArray(value)) {
    return value.map(makeJsonSafe);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, makeJsonSafe(item)]));
  }
  return value ?? null;
}

async function runTool(action) {
  try {
    return await action();
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `WEB.DE request failed: ${describeError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

const emailSchema = z.array(z.string().email()).min(1);
const optionalEmailListSchema = z.array(z.string().email()).optional();
const mailboxSchema = z.string().min(1);
const uidSchema = z.number().int().positive();
const uidListSchema = z.array(uidSchema).min(1).max(100);
const attachmentSchema = z
  .array(
    z.object({
      filename: z.string().min(1),
      content: z.string(),
      contentType: z.string().optional(),
    }),
  )
  .optional();
const fileAttachmentSchema = z
  .array(
    z.object({
      path: z.string().min(1),
      filename: z.string().min(1).optional(),
      contentType: z.string().optional(),
    }),
  )
  .optional();

server.registerTool(
  "check_webde_connection",
  {
    title: "Check WEB.DE Connection",
    description: "Verify IMAP access, configured mailbox names, and SMTP access for sending.",
    inputSchema: {},
  },
  async () =>
    runTool(() =>
      withImapClient(async (client, config) => {
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

        const transport = getSmtpTransport(config);
        await transport.verify();

        return makeTextResult(
          `Connected to ${config.email}. IMAP verified at ${config.imapHost}:${config.imapPort}. SMTP verified at ${config.smtpHost}:${config.smtpPort}.`,
          {
            email: config.email,
            imapHost: config.imapHost,
            imapPort: config.imapPort,
            imapSecure: config.imapSecure,
            smtpHost: config.smtpHost,
            smtpPort: config.smtpPort,
            smtpSecure: config.smtpSecure,
            folders: folderChecks,
            availableMailboxes: mailboxes.map((mailbox) => mailbox.path),
          },
        );
      }),
    ),
);

server.registerTool(
  "list_webde_mailboxes",
  {
    title: "List WEB.DE Mailboxes",
    description: "List all folders/mailboxes available through WEB.DE IMAP.",
    inputSchema: {},
  },
  async () =>
    runTool(() =>
      withImapClient(async (client) => {
        const mailboxes = await client.list();
        return makeTextResult(`Found ${mailboxes.length} WEB.DE mailboxes.`, {
          mailboxes: mailboxes.map((mailbox) => ({
            path: mailbox.path,
            name: mailbox.name,
            delimiter: mailbox.delimiter,
            flags: setToArray(mailbox.flags),
            specialUse: mailbox.specialUse || "",
            subscribed: Boolean(mailbox.subscribed),
            listed: Boolean(mailbox.listed),
          })),
        });
      }),
    ),
);

server.registerTool(
  "get_webde_mailbox_status",
  {
    title: "Get WEB.DE Mailbox Status",
    description: "Get message counts and UID metadata for a WEB.DE mailbox.",
    inputSchema: {
      mailbox: mailboxSchema,
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const status = await client.status(mailbox, {
          messages: true,
          recent: true,
          unseen: true,
          uidNext: true,
          uidValidity: true,
          highestModseq: true,
        });

        return makeTextResult(`Status loaded for ${mailbox}.`, {
          mailbox,
          messages: stringifyNumberLike(status.messages),
          recent: stringifyNumberLike(status.recent),
          unseen: stringifyNumberLike(status.unseen),
          uidNext: stringifyNumberLike(status.uidNext),
          uidValidity: stringifyNumberLike(status.uidValidity),
          highestModseq: stringifyNumberLike(status.highestModseq),
        });
      }),
    ),
);

server.registerTool(
  "get_webde_quota",
  {
    title: "Get WEB.DE Quota",
    description: "Get storage quota information reported by the WEB.DE IMAP server.",
    inputSchema: {
      mailbox: z.string().optional(),
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const quota = await client.getQuota(mailbox || undefined);
        return makeTextResult(quota ? "Loaded WEB.DE quota information." : "WEB.DE did not return quota information.", {
          mailbox: mailbox || null,
          quota: makeJsonSafe(quota),
        });
      }),
    ),
);

server.registerTool(
  "search_webde_messages",
  {
    title: "Search WEB.DE Messages",
    description: "Search a WEB.DE mailbox and return message summaries. Uses IMAP search terms.",
    inputSchema: {
      mailbox: mailboxSchema.default("INBOX"),
      text: z.string().optional(),
      subject: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      cc: z.string().optional(),
      body: z.string().optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      on: z.string().optional(),
      uid: z.string().optional(),
      unseen: z.boolean().optional(),
      seen: z.boolean().optional(),
      flagged: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  },
  async (input) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, input.mailbox, { readOnly: true }, async () => {
          const searchObject = buildSearchObject(input, { omit: input.subject ? ["subject"] : [] });
          const searchedIds = (await client.search(searchObject, { uid: true })) || [];
          const ids = await filterIdsBySubject(client, searchedIds, input.subject);
          const limit = normalizeLimit(input.limit, config.maxFetchMessages);
          const selectedIds = ids.slice(-limit).reverse();
          const messages = [];

          if (selectedIds.length) {
            for await (const msg of client.fetch(
              selectedIds,
              {
                uid: true,
                flags: true,
                envelope: true,
                internalDate: true,
                size: true,
                bodyStructure: true,
              },
              { uid: true },
            )) {
              messages.push(messageSummary(msg));
            }
          }

          messages.sort((a, b) => selectedIds.indexOf(a.uid) - selectedIds.indexOf(b.uid));

          return makeTextResult(`Found ${ids.length} matching messages in ${input.mailbox}; returning ${messages.length}.`, {
            mailbox: input.mailbox,
            totalMatches: ids.length,
            returned: messages.length,
            messages,
          });
        }),
      ),
    ),
);

server.registerTool(
  "export_webde_message",
  {
    title: "Export WEB.DE Message",
    description: "Export a full raw WEB.DE message as a local .eml file.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      filename: z.string().min(1).optional(),
    },
  },
  async ({ mailbox, uid, filename }) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, mailbox, { readOnly: true }, async () => {
          fs.mkdirSync(config.attachmentDownloadDir, { recursive: true });
          const msg = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
          if (!msg) {
            throw new Error(`Message UID ${uid} was not found in ${mailbox}.`);
          }

          const { meta, content } = await client.download(String(uid), undefined, {
            uid: true,
            maxBytes: config.maxSourceBytes,
          });
          const subject = msg.envelope?.subject ? sanitizeFilename(msg.envelope.subject).slice(0, 80) : `message-${uid}`;
          const outputPath = uniqueFilePath(config.attachmentDownloadDir, filename || `${subject}-${uid}.eml`);
          ensureInside(config.attachmentDownloadDir, outputPath);
          await pipeline(content, fs.createWriteStream(outputPath));

          return makeTextResult(`Exported ${mailbox}/${uid} to ${outputPath}.`, {
            mailbox,
            uid,
            outputPath,
            filename: path.basename(outputPath),
            contentType: meta.contentType || "message/rfc822",
            expectedSize: meta.expectedSize ?? null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "read_webde_message",
  {
    title: "Read WEB.DE Message",
    description: "Read and parse a WEB.DE message body by mailbox and UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      includeHtml: z.boolean().default(false),
    },
  },
  async ({ mailbox, uid, includeHtml }) =>
    runTool(() =>
      withImapClient(async (client, config) => {
        const { msg, parsed } = await fetchParsedMessage(client, mailbox, uid, config);
        const summary = messageSummary(msg);
        const text = parsedMessageText(parsed);
        return makeTextResult(`Loaded message ${uid} from ${mailbox}: ${summary.subject || "(no subject)"}.`, {
          mailbox,
          uid,
          ...summary,
          parsed: {
            subject: parsed.subject || "",
            messageId: parsed.messageId || "",
            inReplyTo: parsed.inReplyTo || "",
            references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
            date: parsed.date ? new Date(parsed.date).toISOString() : null,
            from: parsedAddressList(parsed.from),
            to: parsedAddressList(parsed.to),
            cc: parsedAddressList(parsed.cc),
            bcc: parsedAddressList(parsed.bcc),
            replyTo: parsedAddressList(parsed.replyTo),
            text,
            textSource: parsedMessageTextSource(parsed),
            hasHtmlBody: typeof parsed.html === "string" && parsed.html.trim().length > 0,
            html: includeHtml ? parsed.html || "" : "",
            attachments: (parsed.attachments || []).map((attachment, index) => ({
              index,
              filename: attachment.filename || `attachment-${index + 1}`,
              contentType: attachment.contentType || "application/octet-stream",
              size: attachment.size ?? attachment.content?.length ?? null,
              contentId: attachment.contentId || "",
              related: Boolean(attachment.related),
            })),
          },
        });
      }),
    ),
);

server.registerTool(
  "download_webde_attachment",
  {
    title: "Download WEB.DE Attachment",
    description: "Download one attachment/body part from a WEB.DE message to the configured local attachment directory.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      part: z.string().min(1),
      filename: z.string().min(1).optional(),
    },
  },
  async ({ mailbox, uid, part, filename }) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, mailbox, { readOnly: true }, async () => {
          fs.mkdirSync(config.attachmentDownloadDir, { recursive: true });
          const { meta, content } = await client.download(String(uid), part, {
            uid: true,
            maxBytes: config.maxAttachmentBytes,
          });
          const outputPath = uniqueFilePath(
            config.attachmentDownloadDir,
            filename || meta.filename || defaultDownloadFilename(uid, part, meta.contentType),
          );
          ensureInside(config.attachmentDownloadDir, outputPath);
          await pipeline(content, fs.createWriteStream(outputPath));
          const downloadedSize = fs.statSync(outputPath).size;

          return makeTextResult(`Downloaded attachment part ${part} from ${mailbox}/${uid}.`, {
            mailbox,
            uid,
            part,
            outputPath,
            filename: path.basename(outputPath),
            contentType: meta.contentType || "application/octet-stream",
            size: downloadedSize,
            expectedSize: downloadedSize,
          });
        }),
      ),
    ),
);

server.registerTool(
  "create_webde_draft",
  {
    title: "Create WEB.DE Draft",
    description: "Create a draft email in the configured WEB.DE drafts folder without sending it.",
    inputSchema: {
      to: emailSchema,
      subject: z.string().default(""),
      text: z.string().default(""),
      html: z.string().optional(),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      replyTo: z.string().email().optional(),
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
    },
  },
  async ({ to, subject, text, html, cc, bcc, replyTo, attachments, fileAttachments }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the draft.");
    }

    return runTool(() =>
      withImapClient(async (client, config) => {
        const message = await buildMessage({
          from: fromAddress(config),
          to,
          cc,
          bcc,
          replyTo,
          subject,
          text,
          html,
          attachments: buildOutgoingAttachments(attachments, fileAttachments, config),
          keepBcc: true,
          headers: {
            "X-Unsent": "1",
          },
        });

        const appendResult = await client.append(config.folders.drafts, message, ["\\Draft"]);
        if (!appendResult) {
          throw new Error("WEB.DE did not confirm the draft append request.");
        }

        return makeTextResult(`Draft saved to ${config.folders.drafts} for ${to.join(", ")}.`, {
          mailbox: config.folders.drafts,
          uid: stringifyNumberLike(appendResult.uid),
          uidValidity: stringifyNumberLike(appendResult.uidValidity),
          subject,
          to,
          cc: cc || [],
          bcc: bcc || [],
          attachmentCount: (attachments?.length || 0) + (fileAttachments?.length || 0),
        });
      }),
    );
  },
);

server.registerTool(
  "send_webde_email",
  {
    title: "Send WEB.DE Email",
    description: "Send an email through the connected WEB.DE account using SMTP.",
    inputSchema: {
      to: emailSchema,
      subject: z.string().default(""),
      text: z.string().default(""),
      html: z.string().optional(),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      replyTo: z.string().email().optional(),
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
      saveSentCopy: z.boolean().optional(),
    },
  },
  async ({ to, subject, text, html, cc, bcc, replyTo, attachments, fileAttachments, saveSentCopy }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the email.");
    }

    return runTool(async () => {
      const config = await loadRuntimeConfig({ pluginRoot });
      const result = await sendMailAndMaybeSaveSent(config, {
        to,
        subject,
        text,
        html,
        cc,
        bcc,
        replyTo,
        attachments,
        fileAttachments,
        saveSentCopy,
      });

      return makeTextResult(`Email sent to ${to.join(", ")} from ${config.email}.`, result);
    });
  },
);

server.registerTool(
  "reply_webde_email",
  {
    title: "Reply To WEB.DE Email",
    description: "Reply or reply-all to an existing WEB.DE message by mailbox and UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      text: z.string().default(""),
      html: z.string().optional(),
      replyAll: z.boolean().default(false),
      includeOriginal: z.boolean().default(true),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
      saveSentCopy: z.boolean().optional(),
    },
  },
  async ({ mailbox, uid, text, html, replyAll, includeOriginal, cc, bcc, attachments, fileAttachments, saveSentCopy }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the reply.");
    }

    return runTool(() =>
      withImapClient(async (client, config) => {
        const { parsed } = await fetchParsedMessage(client, mailbox, uid, config);
        const recipients = replyRecipients(parsed, config, replyAll);
        if (!recipients.to.length) {
          throw new Error("No reply recipient could be inferred from the original message.");
        }

        const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
        const messageId = parsed.messageId || "";
        const result = await sendMailAndMaybeSaveSent(config, {
          to: recipients.to,
          cc: [...recipients.cc, ...(cc || [])],
          bcc,
          subject: prefixedSubject(parsed.subject, "Re"),
          text: `${text}${includeOriginal ? quoteOriginal(parsed) : ""}`,
          html,
          attachments,
          fileAttachments,
          saveSentCopy,
          headers: {
            ...(messageId ? { "In-Reply-To": messageId } : {}),
            ...(references.length || messageId ? { References: [...references, messageId].filter(Boolean).join(" ") } : {}),
          },
        });

        return makeTextResult(`Reply sent for ${mailbox}/${uid}.`, {
          original: { mailbox, uid, subject: parsed.subject || "" },
          to: recipients.to,
          cc: [...recipients.cc, ...(cc || [])],
          ...result,
        });
      }),
    );
  },
);

server.registerTool(
  "forward_webde_email",
  {
    title: "Forward WEB.DE Email",
    description: "Forward an existing WEB.DE message by mailbox and UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uid: uidSchema,
      to: emailSchema,
      text: z.string().default(""),
      html: z.string().optional(),
      cc: optionalEmailListSchema,
      bcc: optionalEmailListSchema,
      includeOriginalAttachments: z.boolean().default(false),
      attachments: attachmentSchema,
      fileAttachments: fileAttachmentSchema,
      saveSentCopy: z.boolean().optional(),
    },
  },
  async ({
    mailbox,
    uid,
    to,
    text,
    html,
    cc,
    bcc,
    includeOriginalAttachments,
    attachments,
    fileAttachments,
    saveSentCopy,
  }) =>
    runTool(() =>
      withImapClient(async (client, config) => {
        const { parsed } = await fetchParsedMessage(client, mailbox, uid, config);
        const originalAttachments = includeOriginalAttachments
          ? (parsed.attachments || []).map((attachment, index) => ({
              filename: attachment.filename || `forwarded-attachment-${index + 1}`,
              content: attachment.content,
              contentType: attachment.contentType || undefined,
            }))
          : [];

        const forwardText = `${text || ""}\n\n---------- Forwarded message ---------\nFrom: ${firstAddress(parsed.from)}\nDate: ${
          parsed.date ? new Date(parsed.date).toISOString() : ""
        }\nSubject: ${parsed.subject || ""}\nTo: ${parsedAddressList(parsed.to)
          .map((address) => address.address)
          .join(", ")}\n\n${parsedMessageText(parsed)}`;

        const result = await sendMailAndMaybeSaveSent(config, {
          to,
          cc,
          bcc,
          subject: prefixedSubject(parsed.subject, "Fwd"),
          text: forwardText,
          html,
          attachments: [...(attachments || []), ...originalAttachments],
          fileAttachments,
          saveSentCopy,
        });

        return makeTextResult(`Forwarded ${mailbox}/${uid} to ${to.join(", ")}.`, {
          original: { mailbox, uid, subject: parsed.subject || "" },
          to,
          includedOriginalAttachments: originalAttachments.length,
          ...result,
        });
      }),
    ),
);

server.registerTool(
  "mark_webde_messages",
  {
    title: "Mark WEB.DE Messages",
    description: "Mark WEB.DE messages as read, unread, starred, or unstarred by UID.",
    inputSchema: {
      mailbox: mailboxSchema,
      uids: uidListSchema,
      action: z.enum(["read", "unread", "star", "unstar"]),
    },
  },
  async ({ mailbox, uids, action }) =>
    runTool(() =>
      withImapClient((client) =>
        withMailbox(client, mailbox, { readOnly: false }, async () => {
          const flag = action === "read" || action === "unread" ? "\\Seen" : "\\Flagged";
          const add = action === "read" || action === "star";
          const ok = add
            ? await client.messageFlagsAdd(uids, [flag], { uid: true })
            : await client.messageFlagsRemove(uids, [flag], { uid: true });

          return makeTextResult(`Marked ${uids.length} message(s) in ${mailbox} as ${action}.`, {
            mailbox,
            uids,
            action,
            ok,
          });
        }),
      ),
    ),
);

server.registerTool(
  "move_webde_messages",
  {
    title: "Move WEB.DE Messages",
    description: "Move WEB.DE messages from one mailbox to another by UID.",
    inputSchema: {
      sourceMailbox: mailboxSchema,
      destinationMailbox: mailboxSchema,
      uids: uidListSchema,
    },
  },
  async ({ sourceMailbox, destinationMailbox, uids }) =>
    runTool(() =>
      withImapClient((client) =>
        withMailbox(client, sourceMailbox, { readOnly: false }, async () => {
          const result = await client.messageMove(uids, destinationMailbox, { uid: true });
          return makeTextResult(`Moved ${uids.length} message(s) from ${sourceMailbox} to ${destinationMailbox}.`, {
            sourceMailbox,
            destinationMailbox,
            uids,
            uidMap: result?.uidMap ? Object.fromEntries(result.uidMap) : null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "delete_webde_messages",
  {
    title: "Delete WEB.DE Messages",
    description: "Move WEB.DE messages to trash, or permanently delete them when permanent is true.",
    inputSchema: {
      mailbox: mailboxSchema,
      uids: uidListSchema,
      permanent: z.boolean().default(false),
    },
  },
  async ({ mailbox, uids, permanent }) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, mailbox, { readOnly: false }, async () => {
          if (permanent) {
            const ok = await client.messageDelete(uids, { uid: true });
            return makeTextResult(`Permanently deleted ${uids.length} message(s) from ${mailbox}.`, {
              mailbox,
              uids,
              permanent: true,
              ok,
            });
          }

          const result = await client.messageMove(uids, config.folders.trash, { uid: true });
          return makeTextResult(`Moved ${uids.length} message(s) from ${mailbox} to ${config.folders.trash}.`, {
            mailbox,
            trashMailbox: config.folders.trash,
            uids,
            permanent: false,
            uidMap: result?.uidMap ? Object.fromEntries(result.uidMap) : null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "copy_webde_messages",
  {
    title: "Copy WEB.DE Messages",
    description: "Copy WEB.DE messages from one mailbox to another by UID.",
    inputSchema: {
      sourceMailbox: mailboxSchema,
      destinationMailbox: mailboxSchema,
      uids: uidListSchema,
    },
  },
  async ({ sourceMailbox, destinationMailbox, uids }) =>
    runTool(() =>
      withImapClient((client) =>
        withMailbox(client, sourceMailbox, { readOnly: false }, async () => {
          const result = await client.messageCopy(uids, destinationMailbox, { uid: true });
          return makeTextResult(`Copied ${uids.length} message(s) from ${sourceMailbox} to ${destinationMailbox}.`, {
            sourceMailbox,
            destinationMailbox,
            uids,
            uidMap: result?.uidMap ? Object.fromEntries(result.uidMap) : null,
          });
        }),
      ),
    ),
);

server.registerTool(
  "create_webde_mailbox",
  {
    title: "Create WEB.DE Mailbox",
    description: "Create a WEB.DE folder/mailbox.",
    inputSchema: {
      mailbox: mailboxSchema,
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const result = await client.mailboxCreate(mailbox);
        return makeTextResult(`Created WEB.DE mailbox ${mailbox}.`, {
          mailbox,
          created: Boolean(result),
          result,
        });
      }),
    ),
);

server.registerTool(
  "rename_webde_mailbox",
  {
    title: "Rename WEB.DE Mailbox",
    description: "Rename a WEB.DE folder/mailbox.",
    inputSchema: {
      mailbox: mailboxSchema,
      newMailbox: mailboxSchema,
    },
  },
  async ({ mailbox, newMailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const result = await client.mailboxRename(mailbox, newMailbox);
        return makeTextResult(`Renamed WEB.DE mailbox ${mailbox} to ${newMailbox}.`, {
          mailbox,
          newMailbox,
          renamed: Boolean(result),
          result,
        });
      }),
    ),
);

server.registerTool(
  "set_webde_mailbox_subscription",
  {
    title: "Set WEB.DE Mailbox Subscription",
    description: "Subscribe or unsubscribe a WEB.DE mailbox in IMAP.",
    inputSchema: {
      mailbox: mailboxSchema,
      subscribed: z.boolean(),
    },
  },
  async ({ mailbox, subscribed }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const ok = subscribed ? await client.mailboxSubscribe(mailbox) : await client.mailboxUnsubscribe(mailbox);
        return makeTextResult(`${subscribed ? "Subscribed to" : "Unsubscribed from"} WEB.DE mailbox ${mailbox}.`, {
          mailbox,
          subscribed,
          ok,
        });
      }),
    ),
);

server.registerTool(
  "delete_webde_mailbox",
  {
    title: "Delete WEB.DE Mailbox",
    description: "Delete a WEB.DE folder/mailbox. This is for user-created folders, not system folders.",
    inputSchema: {
      mailbox: mailboxSchema,
    },
  },
  async ({ mailbox }) =>
    runTool(() =>
      withImapClient(async (client) => {
        const protectedNames = new Set(["INBOX", "Gesendet", "Entwurf", "Entwürfe", "Papierkorb", "Spam", "Postausgang"]);
        if (protectedNames.has(mailbox)) {
          throw new Error(`Refusing to delete protected mailbox: ${mailbox}`);
        }
        const result = await client.mailboxDelete(mailbox);
        return makeTextResult(`Deleted WEB.DE mailbox ${mailbox}.`, {
          mailbox,
          deleted: Boolean(result),
          result,
        });
      }),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
