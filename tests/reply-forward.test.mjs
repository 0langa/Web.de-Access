import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

import { createImapClient, forwardMessage, replyToMessage } from "../mcp/mail.mjs";
import { fakeConfig, fetchReply, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

const ORIGINAL = Buffer.from(
  [
    "From: Alice <alice@example.test>",
    "To: user@example.test",
    "Subject: Quarterly <numbers>",
    "Date: Mon, 12 Oct 2026 09:30:00 +0000",
    "Message-ID: <q3@example.test>",
    "References: <q2@example.test>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Revenue went up & costs <down>.",
    "--b1",
    'Content-Type: application/pdf; name="q3.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="q3.pdf"',
    "",
    Buffer.from("%PDF-1.7 quarterly report").toString("base64"),
    "--b1--",
    "",
  ].join("\r\n"),
);

// Builds messages in memory; nothing can be delivered.
function capturingTransport() {
  const inner = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      const info = await inner.sendMail(mail);
      sent.push(await simpleParser(info.message));
      return info;
    },
  };
}

async function openOriginal(configOverrides = {}) {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, args, write }) => {
      if (command === "UID FETCH") {
        fetchReply({ tag, args, uid: 9, size: ORIGINAL.length, sections: { "": ORIGINAL }, write });
        return true;
      }
      return false;
    },
  });
  const config = fakeConfig({ imapPort: imap.port, saveSentCopy: false, ...configOverrides });
  const client = createImapClient(config, { doSTARTTLS: false });
  await client.connect();
  return {
    client,
    config,
    async close() {
      await client.logout().catch(() => {});
      await imap.close();
    },
  };
}

test("a reply threads to the original and quotes it in the text and the HTML part", { timeout: 15000 }, async () => {
  const mailbox = await openOriginal();
  const transport = capturingTransport();
  try {
    const result = await replyToMessage(
      mailbox.client,
      mailbox.config,
      { mailbox: "INBOX", uid: 9, text: "Thanks!", html: "<p>Thanks!</p>", replyAll: false, includeOriginal: true },
      { transport },
    );

    assert.deepEqual(result.to, ["alice@example.test"]);
    const [reply] = transport.sent;
    assert.equal(reply.subject, "Re: Quarterly <numbers>");
    assert.equal(reply.inReplyTo, "<q3@example.test>");
    assert.deepEqual(reply.references, ["<q2@example.test>", "<q3@example.test>"]);
    assert.match(reply.text, /^Thanks!\n\nOn 2026-10-12T09:30:00\.000Z, alice@example\.test wrote:\n> Revenue went up & costs <down>\./);
    assert.match(reply.html, /^<p>Thanks!<\/p>/);
    assert.match(reply.html, /alice@example\.test wrote:/);
    assert.match(reply.html, /Revenue went up &amp; costs &lt;down&gt;\./);
  } finally {
    await mailbox.close();
  }
});

test("a forward carries the forwarded message in the HTML part too", { timeout: 15000 }, async () => {
  const mailbox = await openOriginal();
  const transport = capturingTransport();
  try {
    const result = await forwardMessage(
      mailbox.client,
      mailbox.config,
      {
        mailbox: "INBOX",
        uid: 9,
        to: ["bob@example.test"],
        text: "FYI",
        html: "<html><body><p>FYI</p></body></html>",
        includeOriginalAttachments: true,
      },
      { transport },
    );

    assert.equal(result.includedOriginalAttachments, 1);
    const [forward] = transport.sent;
    assert.equal(forward.subject, "Fwd: Quarterly <numbers>");
    assert.match(forward.text, /^FYI\n\n---------- Forwarded message ---------\nFrom: alice@example\.test\n/);
    assert.match(forward.text, /Revenue went up & costs <down>\./);
    assert.match(forward.html, /<p>FYI<\/p>/);
    assert.match(forward.html, /---------- Forwarded message ---------/);
    assert.match(forward.html, /Subject: Quarterly &lt;numbers&gt;/);
    assert.match(forward.html, /Revenue went up &amp; costs &lt;down&gt;\.[\s\S]*<\/body>/);
    assert.deepEqual(
      forward.attachments.map((attachment) => [attachment.filename, attachment.content.toString()]),
      [["q3.pdf", "%PDF-1.7 quarterly report"]],
    );
  } finally {
    await mailbox.close();
  }
});
