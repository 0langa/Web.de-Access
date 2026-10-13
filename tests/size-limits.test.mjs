import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImapClient, downloadAttachment, exportMessage, fetchParsedMessage, forwardMessage } from "../mcp/mail.mjs";
import { fakeConfig, fetchReply, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

const LIMIT = 4096;

function base64Lines(buffer) {
  return Buffer.from(`${buffer.toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`);
}

function attachmentSections(data) {
  return {
    "2.MIME": Buffer.from(
      'Content-Type: application/octet-stream; name="report.bin"\r\n' +
        "Content-Transfer-Encoding: base64\r\n" +
        'Content-Disposition: attachment; filename="report.bin"\r\n\r\n',
    ),
    2: base64Lines(data),
  };
}

function rawMessage(bodyBytes) {
  return Buffer.concat([
    Buffer.from("From: sender@example.test\r\nTo: user@example.test\r\nSubject: Archive\r\nMessage-ID: <archive@example.test>\r\n\r\n"),
    Buffer.alloc(bodyBytes, "a"),
  ]);
}

function mailWithAttachment(attachmentBytes) {
  return Buffer.from(
    [
      "From: sender@example.test",
      "To: user@example.test",
      "Subject: Scan",
      "Message-ID: <scan@example.test>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attachment.",
      "--b1",
      'Content-Type: application/pdf; name="scan.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="scan.pdf"',
      "",
      base64Lines(Buffer.alloc(attachmentBytes, "p")).toString(),
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

// Serves one message (UID 5) and returns a connected client plus a fresh download directory.
async function openMailbox(sections, size) {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, args, write }) => {
      if (command === "UID FETCH") {
        fetchReply({ tag, args, uid: 5, size, sections, envelope: '(NIL "Archive" NIL NIL NIL NIL NIL NIL NIL NIL)', write });
        return true;
      }
      return false;
    },
  });
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "webde-download-test-"));
  const config = fakeConfig({
    imapPort: imap.port,
    attachmentDownloadDir: downloadDir,
    maxAttachmentBytes: LIMIT,
    maxSourceBytes: LIMIT,
  });
  const client = createImapClient(config, { doSTARTTLS: false });
  await client.connect();
  await client.mailboxOpen("INBOX", { readOnly: true });
  return {
    client,
    config,
    downloadDir,
    async close() {
      await client.logout().catch(() => {});
      await imap.close();
      fs.rmSync(downloadDir, { recursive: true, force: true });
    },
  };
}

test("an attachment within the size limit is saved completely", { timeout: 15000 }, async () => {
  const data = crypto.randomBytes(LIMIT);
  const mailbox = await openMailbox(attachmentSections(data), 9000);
  try {
    const result = await downloadAttachment(mailbox.client, mailbox.config, { mailbox: "INBOX", uid: 5, part: "2" });
    assert.equal(result.filename, "report.bin");
    assert.equal(result.size, LIMIT);
    assert.deepEqual(fs.readFileSync(result.outputPath), data);
  } finally {
    await mailbox.close();
  }
});

test("an attachment over the size limit fails instead of being saved cut off", { timeout: 15000 }, async () => {
  const mailbox = await openMailbox(attachmentSections(crypto.randomBytes(LIMIT + 1)), 9000);
  try {
    await assert.rejects(
      downloadAttachment(mailbox.client, mailbox.config, { mailbox: "INBOX", uid: 5, part: "2" }),
      /larger than the profile's maxAttachmentMb limit/,
    );
    assert.deepEqual(fs.readdirSync(mailbox.downloadDir), []);
  } finally {
    await mailbox.close();
  }
});

test("a missing attachment part is reported as not found", { timeout: 15000 }, async () => {
  const mailbox = await openMailbox({}, 9000);
  try {
    await assert.rejects(
      downloadAttachment(mailbox.client, mailbox.config, { mailbox: "INBOX", uid: 5, part: "3" }),
      /Part 3 of message UID 5 was not found in INBOX/,
    );
  } finally {
    await mailbox.close();
  }
});

test("a message export within the size limit writes the full .eml", { timeout: 15000 }, async () => {
  const raw = rawMessage(1000);
  const mailbox = await openMailbox({ "": raw }, raw.length);
  try {
    const result = await exportMessage(mailbox.client, mailbox.config, { mailbox: "INBOX", uid: 5 });
    assert.equal(result.filename, "Archive-5.eml");
    assert.deepEqual(fs.readFileSync(result.outputPath), raw);
  } finally {
    await mailbox.close();
  }
});

test("a message export over maxSourceMb fails instead of writing a cut-off .eml", { timeout: 15000 }, async () => {
  const raw = rawMessage(LIMIT);
  // Once with the real RFC822.SIZE, once with a server that under-reports it.
  for (const reportedSize of [raw.length, 100]) {
    const mailbox = await openMailbox({ "": raw }, reportedSize);
    try {
      await assert.rejects(
        exportMessage(mailbox.client, mailbox.config, { mailbox: "INBOX", uid: 5 }),
        /larger than the profile's maxSourceMb limit/,
      );
      assert.deepEqual(fs.readdirSync(mailbox.downloadDir), []);
    } finally {
      await mailbox.close();
    }
  }
});

test("reading a message over maxSourceMb reports that it was cut off", { timeout: 15000 }, async () => {
  const large = mailWithAttachment(LIMIT);
  const mailbox = await openMailbox({ "": large }, large.length);
  try {
    const { truncated } = await fetchParsedMessage(mailbox.client, "INBOX", 5, mailbox.config);
    assert.equal(truncated, true);
  } finally {
    await mailbox.close();
  }

  const small = mailWithAttachment(1000);
  const intact = await openMailbox({ "": small }, small.length);
  try {
    const { truncated, parsed } = await fetchParsedMessage(intact.client, "INBOX", 5, intact.config);
    assert.equal(truncated, false);
    assert.equal(parsed.attachments[0].content.length, 1000);
  } finally {
    await intact.close();
  }
});

test("attachments of a message over maxSourceMb are not forwarded cut off", { timeout: 15000 }, async () => {
  const large = mailWithAttachment(LIMIT);
  const mailbox = await openMailbox({ "": large }, large.length);
  const sent = [];
  const transport = { sendMail: async (mail) => sent.push(mail) };
  try {
    await assert.rejects(
      forwardMessage(
        mailbox.client,
        mailbox.config,
        { mailbox: "INBOX", uid: 5, to: ["bob@example.test"], text: "FYI", includeOriginalAttachments: true },
        { transport },
      ),
      /larger than the profile's maxSourceMb limit/,
    );
    assert.equal(sent.length, 0, "nothing may be sent");
  } finally {
    await mailbox.close();
  }
});
