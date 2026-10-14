import assert from "node:assert/strict";
import test from "node:test";

import { checkConnection, createImapClient } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

// INBOX answers STATUS. "Gesendet" does not exist. "Spam" exists, but the
// server refuses STATUS for it.
async function check(transport) {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, args, write }) => {
      if (command === "LIST" && args === '"" "Spam"') {
        write(`* LIST (\\HasNoChildren \\Junk) "/" "Spam"\r\n${tag} OK LIST completed\r\n`);
        return true;
      }
      if (command === "STATUS") {
        const mailbox = args.slice(0, args.lastIndexOf(" ("));
        if (mailbox === "INBOX") {
          write(`* STATUS INBOX (MESSAGES 3 UNSEEN 1 UIDNEXT 4 UIDVALIDITY 1)\r\n${tag} OK STATUS completed\r\n`);
        } else {
          write(`${tag} NO STATUS failed\r\n`);
        }
        return true;
      }
      return false;
    },
  });
  const config = fakeConfig({ imapPort: imap.port, smtpHost: "smtp.example.test", smtpPort: 587 });
  const client = createImapClient(config, { doSTARTTLS: false });
  try {
    await client.connect();
    return await checkConnection(client, config, { transport });
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
}

test("the connection check reports each configured folder", { timeout: 15000 }, async () => {
  const result = await check({ verify: async () => true });

  assert.deepEqual(result.folders.inbox, {
    mailbox: "INBOX",
    ok: true,
    messages: 3,
    unseen: 1,
    uidNext: 4,
    uidValidity: "1",
  });
  assert.equal(result.folders.sent.ok, false);
  assert.match(result.folders.sent.error, /Mailbox doesn't exist: Gesendet/);
  assert.equal(result.folders.spam.ok, false, "a refused STATUS must not count as a working folder");
  assert.match(result.folders.spam.error, /refused the status request for Spam/);
  assert.deepEqual(result.availableMailboxes, ["INBOX"]);
});

test("an SMTP failure says that IMAP worked and which SMTP endpoint failed", { timeout: 15000 }, async () => {
  const smtpError = Object.assign(new Error("Invalid login"), { response: "535 Authentication credentials invalid" });
  await assert.rejects(
    check({
      verify: async () => {
        throw smtpError;
      },
    }),
    /^Error: IMAP works, but the SMTP check at smtp\.example\.test:587 failed: Invalid login: 535 Authentication credentials invalid$/,
  );
});
