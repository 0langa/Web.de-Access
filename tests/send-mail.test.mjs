import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

import { sendMailAndMaybeSaveSent } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

// The stream transport builds the SMTP message in memory and cannot deliver it.
const offlineSmtp = () => nodemailer.createTransport({ streamTransport: true, buffer: true });
const plainText = { doSTARTTLS: false };

test("a sent message is reported as sent when only its Sent copy fails", { timeout: 15000 }, async () => {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, write }) => {
      if (command === "APPEND") {
        write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
        return true;
      }
      return false;
    },
  });
  try {
    const result = await sendMailAndMaybeSaveSent(
      fakeConfig({ imapPort: imap.port }),
      { to: ["friend@example.test"], subject: "Hello", text: "Hi there" },
      { transport: offlineSmtp(), imapOptions: plainText },
    );

    assert.match(result.messageId, /^<[0-9a-f-]+@web\.de>$/);
    assert.equal(result.sentCopy.mailbox, "Gesendet");
    assert.equal(result.sentCopy.uid, null);
    assert.match(result.sentCopy.error, /Mailbox does not exist/);
  } finally {
    await imap.close();
  }
});

test("the Sent copy keeps the BCC recipients and the delivered Message-ID", { timeout: 15000 }, async () => {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, write }) => {
      if (command === "APPEND") {
        write(`${tag} OK [APPENDUID 7 42] APPEND completed\r\n`);
        return true;
      }
      return false;
    },
  });
  try {
    const transport = offlineSmtp();
    const result = await sendMailAndMaybeSaveSent(
      fakeConfig({ imapPort: imap.port }),
      { to: ["friend@example.test"], bcc: ["hidden@example.test"], subject: "Grüße", text: "Hallo" },
      { transport, imapOptions: plainText },
    );

    assert.deepEqual(result.sentCopy, { mailbox: "Gesendet", uid: 42, uidValidity: "7" });
    const append = imap.commands.find((entry) => entry.command === "APPEND");
    assert.match(append.args, /^Gesendet \(\\Seen\)/);
    const copy = await simpleParser(append.literals[0]);
    assert.equal(copy.messageId, result.messageId);
    assert.equal(copy.subject, "Grüße");
    assert.deepEqual(copy.bcc.value.map((item) => item.address), ["hidden@example.test"]);
  } finally {
    await imap.close();
  }
});
