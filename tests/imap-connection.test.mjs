import assert from "node:assert/strict";
import test from "node:test";

import { describeError, withImapConnection } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

// The fake server offers no TLS, so tests that are not about TLS opt out of
// the STARTTLS requirement explicitly.
const plainText = { doSTARTTLS: false };

test("IMAP without implicit TLS refuses to log in when STARTTLS is missing", { timeout: 15000 }, async () => {
  const imap = await startFakeImapServer();
  try {
    const config = fakeConfig({ imapPort: imap.port, imapSecure: false });
    await assert.rejects(
      withImapConnection(config, async () => "connected"),
      /STARTTLS/,
    );
    assert.equal(
      imap.commands.some((entry) => entry.command === "LOGIN" || entry.command === "AUTHENTICATE"),
      false,
      "the app password must not be sent over an unencrypted connection",
    );
  } finally {
    await imap.close();
  }
});

test("UTF-8 folder names travel as modified UTF-7 in both directions", { timeout: 15000 }, async () => {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, args, write }) => {
      if (command === "LIST" && args !== '"" ""') {
        write(`* LIST (\\HasNoChildren \\Drafts) "/" "Entw&APw-rfe"\r\n* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK LIST completed\r\n`);
        return true;
      }
      return false;
    },
  });
  try {
    const config = fakeConfig({ imapPort: imap.port });
    const paths = await withImapConnection(
      config,
      async (client) => {
        const mailboxes = await client.list();
        await client.mailboxOpen("Entwürfe", { readOnly: true });
        return mailboxes.map((mailbox) => mailbox.path);
      },
      plainText,
    );

    assert.ok(paths.includes("Entwürfe"));
    const examine = imap.commands.find((entry) => entry.command === "EXAMINE");
    assert.match(examine.args, /^"?Entw&APw-rfe"?$/);
  } finally {
    await imap.close();
  }
});

test("a connection failure between commands fails the tool call instead of crashing", { timeout: 15000 }, async () => {
  const imap = await startFakeImapServer({
    onCommand: ({ command, write }) => {
      if (command === "EXAMINE") {
        // A literal above ImapFlow's 1 GiB cap makes it drop the connection and
        // emit "error"; without a listener Node would exit the whole process.
        write("* OK {2147483648}\r\n");
        return true;
      }
      return false;
    },
  });
  try {
    const config = fakeConfig({ imapPort: imap.port });
    await assert.rejects(
      withImapConnection(config, (client) => client.mailboxOpen("INBOX", { readOnly: true }), plainText),
      (error) => {
        assert.match(describeError(error), /Literal size 2147483648 exceeds/);
        return true;
      },
    );
  } finally {
    await imap.close();
  }
});
