import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { loadRuntimeConfig } from "./auth-config.mjs";
import {
  assertUnprotectedMailbox,
  buildMessage,
  buildOutgoingAttachments,
  checkConnection,
  copyMessages,
  deleteMessages,
  describeError,
  downloadAttachment,
  exportMessage,
  fetchParsedMessage,
  formatLimit,
  forwardMessage,
  fromAddress,
  isBodyPartNumber,
  isImapSearchDate,
  isUidSet,
  markMessages,
  messageSummary,
  moveMessages,
  parsedAddressList,
  parsedMessageText,
  parsedMessageTextSource,
  replyToMessage,
  searchMessages,
  sendMailAndMaybeSaveSent,
  sentCopyWarning,
  setMailboxSubscription,
  setToArray,
  stringifyNumberLike,
  truncatedOriginalWarning,
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
const searchDateSchema = (meaning) =>
  z
    .string()
    .refine(isImapSearchDate, "Use a calendar date in YYYY-MM-DD form, for example 2026-10-13.")
    .optional()
    .describe(`${meaning} Calendar date in YYYY-MM-DD form; IMAP compares whole days.`);
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
        const result = await checkConnection(client, config);
        const failedFolders = Object.entries(result.folders)
          .filter(([, check]) => !check.ok)
          .map(([key, check]) => `${key} (${check.mailbox})`);
        const folderNote = failedFolders.length
          ? ` These configured folders could not be opened: ${failedFolders.join(", ")}. Check their exact names with list_webde_mailboxes and update the profile.`
          : "";
        return makeTextResult(
          `Connected to ${config.email}. IMAP verified at ${config.imapHost}:${config.imapPort}. SMTP verified at ${config.smtpHost}:${config.smtpPort}.${folderNote}`,
          result,
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
        if (!status) {
          throw new Error(`WEB.DE refused the status request for ${mailbox}.`);
        }

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
      since: searchDateSchema("Messages received on or after this day."),
      before: searchDateSchema("Messages received before this day."),
      on: searchDateSchema("Messages received on this day."),
      uid: z
        .string()
        .refine(isUidSet, "Use an IMAP UID set such as 42, 40:50, 3,7,9 or 1:*.")
        .optional()
        .describe("IMAP UID set such as 42, 40:50, 3,7,9 or 1:*."),
      unseen: z.boolean().optional(),
      seen: z.boolean().optional(),
      flagged: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  },
  async (input) =>
    runTool(() =>
      withImapClient(async (client, config) => {
        const result = await searchMessages(client, config, input);
        return makeTextResult(
          `Found ${result.totalMatches} matching messages in ${input.mailbox}; returning ${result.returned}.`,
          result,
        );
      }),
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
          const result = await exportMessage(client, config, { mailbox, uid, filename });
          return makeTextResult(
            `Exported ${mailbox}/${uid} to ${result.outputPath}.${result.warning ? ` ${result.warning}` : ""}`,
            result,
          );
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
        const { msg, parsed, truncated } = await fetchParsedMessage(client, mailbox, uid, config);
        const summary = messageSummary(msg);
        const text = parsedMessageText(parsed);
        const truncatedNote = truncated
          ? ` Only the first ${formatLimit(config.maxSourceBytes)} were read (profile maxSourceMb), so the body and attachment list may be incomplete.`
          : "";
        return makeTextResult(`Loaded message ${uid} from ${mailbox}: ${summary.subject || "(no subject)"}.${truncatedNote}`, {
          mailbox,
          uid,
          ...summary,
          sourceTruncated: truncated,
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
      part: z
        .string()
        .refine(isBodyPartNumber, "Use a MIME part number such as 2 or 1.2 from the message's attachments list.")
        .describe("MIME part number such as 2 or 1.2, as listed in the message's attachments."),
      filename: z.string().min(1).optional(),
    },
  },
  async ({ mailbox, uid, part, filename }) =>
    runTool(() =>
      withImapClient((client, config) =>
        withMailbox(client, mailbox, { readOnly: true }, async () => {
          const result = await downloadAttachment(client, config, { mailbox, uid, part, filename });
          return makeTextResult(
            `Downloaded attachment part ${part} from ${mailbox}/${uid}.${result.warning ? ` ${result.warning}` : ""}`,
            result,
          );
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

      return makeTextResult(`Email sent to ${to.join(", ")} from ${config.email}.${sentCopyWarning(result)}`, result);
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
        const result = await replyToMessage(client, config, {
          mailbox,
          uid,
          text,
          html,
          replyAll,
          includeOriginal,
          cc,
          bcc,
          attachments,
          fileAttachments,
          saveSentCopy,
        });
        return makeTextResult(
          `Reply sent for ${mailbox}/${uid}.${sentCopyWarning(result)}${truncatedOriginalWarning(result, config)}`,
          result,
        );
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
        const result = await forwardMessage(client, config, {
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
        });
        return makeTextResult(
          `Forwarded ${mailbox}/${uid} to ${to.join(", ")}.${sentCopyWarning(result)}${truncatedOriginalWarning(result, config)}`,
          result,
        );
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
          const result = await markMessages(client, { mailbox, uids, action });
          return makeTextResult(`Marked ${uids.length} message(s) in ${mailbox} as ${action}.`, result);
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
          const result = await moveMessages(client, { sourceMailbox, destinationMailbox, uids });
          return makeTextResult(`Moved ${uids.length} message(s) from ${sourceMailbox} to ${destinationMailbox}.`, result);
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
          const result = await deleteMessages(client, config, { mailbox, uids, permanent });
          return makeTextResult(
            permanent
              ? `Permanently deleted ${uids.length} message(s) from ${mailbox}.`
              : `Moved ${uids.length} message(s) from ${mailbox} to ${config.folders.trash}.`,
            result,
          );
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
          const result = await copyMessages(client, { sourceMailbox, destinationMailbox, uids });
          return makeTextResult(`Copied ${uids.length} message(s) from ${sourceMailbox} to ${destinationMailbox}.`, result);
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
      withImapClient(async (client, config) => {
        await assertUnprotectedMailbox(client, mailbox, config, "rename");
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
        const result = await setMailboxSubscription(client, { mailbox, subscribed });
        return makeTextResult(`${subscribed ? "Subscribed to" : "Unsubscribed from"} WEB.DE mailbox ${mailbox}.`, result);
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
      withImapClient(async (client, config) => {
        await assertUnprotectedMailbox(client, mailbox, config, "delete");
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
