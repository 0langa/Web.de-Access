import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ImapFlow } from "imapflow";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import nodemailer from "nodemailer";
import * as z from "zod/v4";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const envPath = path.join(pluginRoot, ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

const server = new McpServer({
  name: "webde-drafts",
  version: "0.1.0",
  instructions:
    "Use this server to create WEB.DE drafts via IMAP APPEND and send emails via SMTP. Do not use it to inspect inbox contents.",
});

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required setting: ${name}`);
  }
  return value.trim();
}

function parsePort(value, fallback, envName) {
  const chosen = value?.trim() ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(chosen) || chosen <= 0) {
    throw new Error(`${envName} must be a positive integer.`);
  }
  return chosen;
}

function getConfig() {
  return {
    email: requireEnv("WEBDE_EMAIL"),
    password: requireEnv("WEBDE_PASSWORD"),
    draftsMailbox: process.env.WEBDE_DRAFTS_MAILBOX?.trim() || "Entwurf",
    imapHost: process.env.WEBDE_IMAP_HOST?.trim() || "imap.web.de",
    imapPort: parsePort(process.env.WEBDE_IMAP_PORT, 993, "WEBDE_IMAP_PORT"),
    imapSecure: (process.env.WEBDE_IMAP_SECURE?.trim() || "true").toLowerCase() !== "false",
    smtpHost: process.env.WEBDE_SMTP_HOST?.trim() || "smtp.web.de",
    smtpPort: parsePort(process.env.WEBDE_SMTP_PORT, 587, "WEBDE_SMTP_PORT"),
    smtpSecure: (process.env.WEBDE_SMTP_SECURE?.trim() || "false").toLowerCase() === "true",
  };
}

async function withImapClient(work) {
  const config = getConfig();
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.email,
      pass: config.password,
    },
  });

  await client.connect();
  try {
    return await work(client, config);
  } finally {
    await client.logout().catch(() => {});
  }
}

function getSmtpTransport(config) {
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

function resolveFileAttachment(attachment) {
  const resolvedPath = path.resolve(attachment.path);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Attachment file does not exist: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Attachment path is not a file: ${resolvedPath}`);
  }

  return {
    path: resolvedPath,
    filename: attachment.filename || path.basename(resolvedPath),
    contentType: attachment.contentType || undefined,
  };
}

function buildOutgoingAttachments(inlineAttachments, fileAttachments) {
  const combined = [];

  for (const attachment of inlineAttachments || []) {
    combined.push({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType || undefined,
    });
  }

  for (const attachment of fileAttachments || []) {
    combined.push(resolveFileAttachment(attachment));
  }

  return combined.length ? combined : undefined;
}

async function verifyDraftMailbox(client, mailbox) {
  const status = await client.mailboxOpen(mailbox, { readOnly: true });
  await client.mailboxClose();
  return status;
}

async function buildMessage({ from, to, cc, bcc, subject, text, html, replyTo, headers }) {
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
  });

  const compiled = composer.compile();
  return promisify(compiled.build.bind(compiled))();
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

function stringifyNumberLike(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value ?? null;
}

function describeError(error) {
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
    return [...new Set(parts)].join(": ") || "Unknown error";
  }
  return String(error);
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
const attachmentSchema = z.array(
  z.object({
    filename: z.string().min(1),
    content: z.string(),
    contentType: z.string().optional(),
  }),
).optional();
const fileAttachmentSchema = z.array(
  z.object({
    path: z.string().min(1),
    filename: z.string().min(1).optional(),
    contentType: z.string().optional(),
  }),
).optional();

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
    },
  },
  async ({ to, subject, text, html, cc, bcc, replyTo }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the draft.");
    }

    return runTool(() =>
      withImapClient(async (client, config) => {
        await verifyDraftMailbox(client, config.draftsMailbox);
        const message = await buildMessage({
          from: config.email,
          to,
          cc,
          bcc,
          replyTo,
          subject,
          text,
          html,
          headers: {
            "X-Unsent": "1",
          },
        });

        const appendResult = await client.append(config.draftsMailbox, message, ["\\Draft"]);
        if (!appendResult) {
          throw new Error("WEB.DE did not confirm the draft append request.");
        }

        return makeTextResult(`Draft saved to ${config.draftsMailbox} for ${to.join(", ")}.`, {
          mailbox: config.draftsMailbox,
          uid: stringifyNumberLike(appendResult.uid),
          uidValidity: stringifyNumberLike(appendResult.uidValidity),
          subject,
          to,
          cc: cc || [],
          bcc: bcc || [],
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
    },
  },
  async ({ to, subject, text, html, cc, bcc, replyTo, attachments, fileAttachments }) => {
    if (!text.trim() && !(html && html.trim())) {
      throw new Error("Provide either plain text or HTML content for the email.");
    }

    return runTool(async () => {
      const config = getConfig();
      const transport = getSmtpTransport(config);
      const result = await transport.sendMail({
        from: config.email,
        to,
        cc: cc?.length ? cc : undefined,
        bcc: bcc?.length ? bcc : undefined,
        replyTo: replyTo || undefined,
        subject,
        text,
        html: html || undefined,
        attachments: buildOutgoingAttachments(attachments, fileAttachments),
      });

      return makeTextResult(`Email sent to ${to.join(", ")} from ${config.email}.`, {
        messageId: result.messageId ?? null,
        accepted: result.accepted ?? [],
        rejected: result.rejected ?? [],
        response: result.response ?? null,
      });
    });
  },
);

server.registerTool(
  "check_webde_connection",
  {
    title: "Check WEB.DE Connection",
    description: "Verify IMAP access to the configured drafts folder and SMTP access for sending.",
    inputSchema: {},
  },
  async () =>
    runTool(() =>
      withImapClient(async (client, config) => {
        const mailboxStatus = await verifyDraftMailbox(client, config.draftsMailbox);
        const transport = getSmtpTransport(config);
        await transport.verify();

        return makeTextResult(
          `Connected to ${config.email}. Drafts mailbox verified: ${config.draftsMailbox}. SMTP verified: ${config.smtpHost}:${config.smtpPort}.`,
          {
            email: config.email,
            draftsMailbox: config.draftsMailbox,
            mailboxExists: true,
            messageCount: stringifyNumberLike(mailboxStatus.exists),
            imapHost: config.imapHost,
            imapPort: config.imapPort,
            imapSecure: config.imapSecure,
            smtpHost: config.smtpHost,
            smtpPort: config.smtpPort,
            smtpSecure: config.smtpSecure,
          },
        );
      }),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
