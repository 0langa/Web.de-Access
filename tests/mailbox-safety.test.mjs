import assert from "node:assert/strict";
import test from "node:test";

import { assertDeletableMailbox, createImapClient, deleteMessages } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

test("system folders and the folders the profile uses cannot be deleted", () => {
  const config = fakeConfig();
  config.folders = { ...config.folders, sent: "Sent Items", trash: "Deleted Items" };

  for (const mailbox of ["INBOX", "inbox", "Gesendet", "Papierkorb", "Entwürfe", "Sent Items", "Deleted Items", "Sent Items/", "wichtig"]) {
    assert.throws(() => assertDeletableMailbox(mailbox, config), /Refusing to delete protected mailbox/, mailbox);
  }
  for (const mailbox of ["Projekte", "INBOX/Archiv", "Sent Items/2025"]) {
    assert.doesNotThrow(() => assertDeletableMailbox(mailbox, config), mailbox);
  }
});

async function permanentDelete(capabilities) {
  const imap = await startFakeImapServer({
    capabilities,
    onCommand: ({ tag, command, write }) => {
      if (command === "UID STORE") {
        write(`* 1 FETCH (UID 7 FLAGS (\\Deleted))\r\n${tag} OK STORE completed\r\n`);
        return true;
      }
      if (command === "UID EXPUNGE" || command === "EXPUNGE") {
        write(`* 1 EXPUNGE\r\n${tag} OK EXPUNGE completed\r\n`);
        return true;
      }
      return false;
    },
  });
  const config = fakeConfig({ imapPort: imap.port });
  const client = createImapClient(config, { doSTARTTLS: false });
  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    const result = await deleteMessages(client, config, { mailbox: "INBOX", uids: [7], permanent: true }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    return { ...result, commands: imap.commands.map((entry) => entry.command) };
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
}

test("permanent delete expunges only the requested UIDs", { timeout: 15000 }, async () => {
  const { value, error, commands } = await permanentDelete("IMAP4rev1 UIDPLUS");
  assert.equal(error, undefined);
  assert.equal(value.permanent, true);
  assert.ok(commands.includes("UID EXPUNGE"));
  assert.ok(!commands.includes("EXPUNGE"));
});

test("permanent delete is refused when the server could only expunge the whole mailbox", { timeout: 15000 }, async () => {
  const { error, commands } = await permanentDelete("IMAP4rev1");
  assert.match(error.message, /does not support UIDPLUS/);
  assert.ok(!commands.includes("UID STORE"), "no message may be flagged");
  assert.ok(!commands.includes("EXPUNGE"));
});
