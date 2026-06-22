import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const recipient = process.env.WEBDE_E2E_RECIPIENT;
if (!recipient) {
  throw new Error("Set WEBDE_E2E_RECIPIENT to an address that can receive test mail.");
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["./mcp/server.mjs"],
  cwd: process.cwd(),
});
const client = new Client({ name: "webde-access-email-e2e", version: "0.1.0" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${result.content?.[0]?.text || "unknown error"}`);
  }
  return result.structuredContent;
}

await client.connect(transport);

let draft;
let sent;
try {
  const token = new Date().toISOString().replace(/[^0-9]/g, "");
  const connection = await call("check_webde_connection", {});

  draft = await call("create_webde_draft", {
    to: [recipient],
    bcc: [recipient],
    subject: `[WEBDE-E2E-${token}] Local draft persistence`,
    text: `Draft persistence token ${token}`,
    fileAttachments: [{ path: fileURLToPath(new URL("../README.md", import.meta.url)) }],
  });
  const savedDraft = await call("read_webde_message", {
    mailbox: draft.mailbox,
    uid: Number(draft.uid),
    includeHtml: false,
  });
  assert.deepEqual(savedDraft.parsed.bcc.map((item) => item.address), [recipient]);
  assert.equal(savedDraft.attachments[0].filename, "README.md");

  sent = await call("send_webde_email", {
    to: [connection.email],
    bcc: [recipient],
    subject: `[WEBDE-E2E-${token}] Local sent persistence`,
    text: `Sent persistence token ${token}`,
    saveSentCopy: true,
  });
  const savedSent = await call("read_webde_message", {
    mailbox: sent.sentCopy.mailbox,
    uid: Number(sent.sentCopy.uid),
    includeHtml: false,
  });
  assert.equal(savedSent.messageId, sent.messageId);
  assert.deepEqual(savedSent.parsed.bcc.map((item) => item.address), [recipient]);

  console.log(
    JSON.stringify(
      {
        draftMailbox: draft.mailbox,
        draftBccPreserved: true,
        draftAttachmentPreserved: true,
        sentMailbox: sent.sentCopy.mailbox,
        sentBccPreserved: true,
        messageIdPreserved: true,
        deliveredMessageId: sent.messageId,
      },
      null,
      2,
    ),
  );
} finally {
  if (draft?.uid) {
    await call("delete_webde_messages", {
      mailbox: draft.mailbox,
      uids: [Number(draft.uid)],
      permanent: true,
    }).catch(() => {});
  }
  if (sent?.sentCopy?.uid) {
    await call("delete_webde_messages", {
      mailbox: sent.sentCopy.mailbox,
      uids: [Number(sent.sentCopy.uid)],
      permanent: true,
    }).catch(() => {});
  }
  await client.close();
}
