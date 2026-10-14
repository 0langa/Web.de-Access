import assert from "node:assert/strict";
import test from "node:test";

import { assertUnprotectedMailbox, createImapClient, deleteMessages, markMessages, withMailbox } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

test("system folders and the folders the profile uses cannot be deleted or renamed", () => {
  const config = fakeConfig();
  config.folders = { ...config.folders, sent: "Sent Items", trash: "Deleted Items" };

  for (const action of ["delete", "rename"]) {
    for (const mailbox of ["INBOX", "inbox", "Gesendet", "Papierkorb", "Entwürfe", "Sent Items", "Deleted Items", "Sent Items/", "wichtig"]) {
      assert.throws(
        () => assertUnprotectedMailbox(mailbox, config, action),
        new RegExp(`Refusing to ${action} protected mailbox`),
        `${action} ${mailbox}`,
      );
    }
    for (const mailbox of ["Projekte", "INBOX/Archiv", "Sent Items/2025"]) {
      assert.doesNotThrow(() => assertUnprotectedMailbox(mailbox, config, action), `${action} ${mailbox}`);
    }
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

// Like any IMAP server, this one expunges every message flagged \Deleted when
// a mailbox opened read-write (SELECT) is closed with CLOSE (RFC 3501 6.4.2).
// UID 8 stands for a message another mail client only flagged \Deleted, for
// example Outlook's "mark for deletion" before a purge.
async function withOtherClientsDeletedMessage(capabilities, work) {
  const expunged = [];
  let readWrite = false;
  const imap = await startFakeImapServer({
    capabilities,
    onCommand: ({ tag, command, write }) => {
      if (command === "SELECT" || command === "EXAMINE") {
        readWrite = command === "SELECT";
        return false;
      }
      if (command === "CLOSE") {
        if (readWrite) {
          expunged.push(8);
        }
        write(`${tag} OK CLOSE completed\r\n`);
        return true;
      }
      if (command === "UID STORE" || command === "UID MOVE") {
        write(`${tag} OK completed\r\n`);
        return true;
      }
      return false;
    },
  });
  const config = fakeConfig({ imapPort: imap.port });
  const client = createImapClient(config, { doSTARTTLS: false });
  try {
    await client.connect();
    await work(client, config).catch(() => {});
    return expunged;
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
}

test("tool calls never expunge messages that another mail client only flagged \Deleted", { timeout: 15000 }, async () => {
  const calls = {
    "marking a message as read": [
      "IMAP4rev1 UIDPLUS MOVE",
      (client) => withMailbox(client, "INBOX", { readOnly: false }, () => markMessages(client, { mailbox: "INBOX", uids: [7], action: "read" })),
    ],
    "moving a message to the trash": [
      "IMAP4rev1 UIDPLUS MOVE",
      (client, config) =>
        withMailbox(client, "INBOX", { readOnly: false }, () => deleteMessages(client, config, { mailbox: "INBOX", uids: [7], permanent: false })),
    ],
    "a permanent delete refused for lack of UIDPLUS": [
      "IMAP4rev1",
      (client, config) =>
        withMailbox(client, "INBOX", { readOnly: false }, () => deleteMessages(client, config, { mailbox: "INBOX", uids: [7], permanent: true })),
    ],
  };
  for (const [name, [capabilities, work]] of Object.entries(calls)) {
    assert.deepEqual(await withOtherClientsDeletedMessage(capabilities, work), [], name);
  }
});
