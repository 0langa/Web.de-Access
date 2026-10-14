import assert from "node:assert/strict";
import test from "node:test";

import { assertUnprotectedMailbox, createImapClient, deleteMessages, markMessages, withMailbox } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

// Runs `work` with refusal(mailbox, action), which resolves to the message
// that refuses to delete or rename the folder, or to null when it may be
// changed. The fake server lists `mailboxes`.
async function withProtectionCheck({ mailboxes, capabilities = "IMAP4rev1 UIDPLUS SPECIAL-USE", onCommand } = {}, work) {
  const imap = await startFakeImapServer({ capabilities, mailboxes, onCommand });
  const config = fakeConfig({ imapPort: imap.port });
  const client = createImapClient(config, { doSTARTTLS: false });
  try {
    await client.connect();
    const refusal = (mailbox, action) =>
      assertUnprotectedMailbox(client, mailbox, config, action).then(
        () => null,
        (error) => error.message,
      );
    await work(refusal, config);
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
}

test("system folders and the folders the profile uses cannot be deleted or renamed, in any case", { timeout: 15000 }, async () => {
  await withProtectionCheck({}, async (refusal, config) => {
    config.folders = { ...config.folders, sent: "Sent Items", trash: "Deleted Items" };
    const protectedNames = [
      ...["INBOX", "inbox", "Gesendet", "GESENDET", "Papierkorb", "papierkorb", "Entwürfe", "ENTWÜRFE", "Unbekannt", "unbekannt"],
      // "Entwürfe" with a decomposed ü (NFD).
      "Entwürfe",
      ...["Sent Items", "sent items", "Deleted Items", "Sent Items/", "wichtig", "Wichtig"],
    ];
    for (const action of ["delete", "rename"]) {
      for (const mailbox of protectedNames) {
        assert.equal(await refusal(mailbox, action), `Refusing to ${action} protected mailbox: ${mailbox}`, `${action} ${mailbox}`);
      }
      for (const mailbox of ["Projekte", "INBOX/Archiv", "Sent Items/2025"]) {
        assert.equal(await refusal(mailbox, action), null, `${action} ${mailbox}`);
      }
    }
  });
});

// A server with SPECIAL-USE (RFC 6154) marks its system folders, here under
// English names the profile does not map. "Spamverdacht" carries its
// attribute in lower case.
const specialUseMailboxes = [
  ["INBOX", "\\HasChildren"],
  ["INBOX/Archiv", "\\HasNoChildren"],
  ["Sent", "\\HasNoChildren", "\\Sent"],
  ["Drafts", "\\HasNoChildren", "\\Drafts"],
  ["Trash", "\\HasNoChildren", "\\Trash"],
  ["Spamverdacht", "\\HasNoChildren", "\\junk"],
  ["Archive", "\\HasChildren", "\\Archive"],
  ["Archive/2025", "\\HasNoChildren"],
  ["All Mail", "\\HasNoChildren", "\\All"],
  ["Projekte", "\\HasNoChildren"],
];

test("folders the server marks as special-use cannot be deleted or renamed", { timeout: 15000 }, async () => {
  await withProtectionCheck({ mailboxes: specialUseMailboxes }, async (refusal) => {
    const marked = [
      ["Sent", "\\Sent"],
      ["sent", "\\Sent"],
      ["Drafts", "\\Drafts"],
      ["Trash", "\\Trash"],
      ["Spamverdacht", "\\Junk"],
      ["Archive/", "\\Archive"],
      ["All Mail", "\\All"],
    ];
    for (const action of ["delete", "rename"]) {
      for (const [mailbox, attribute] of marked) {
        assert.equal(
          await refusal(mailbox, action),
          `Refusing to ${action} protected mailbox: ${mailbox} (WEB.DE marks it as ${attribute})`,
          `${action} ${mailbox}`,
        );
      }
      for (const mailbox of ["Projekte", "Archive/2025", "INBOX/Archiv"]) {
        assert.equal(await refusal(mailbox, action), null, `${action} ${mailbox}`);
      }
    }
  });
});

test("special-use folders below a namespace prefix are found by their short name", { timeout: 15000 }, async () => {
  // Courier and Cyrus keep personal folders below "INBOX.". ImapFlow turns
  // "Sent" into "INBOX.Sent" before it sends DELETE or RENAME.
  const namespace = ({ tag, command, write }) => {
    if (command !== "NAMESPACE") {
      return false;
    }
    write(`* NAMESPACE (("INBOX." ".")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
    return true;
  };
  const mailboxes = [
    ["INBOX", "\\HasChildren"],
    ["INBOX.Sent", "\\HasNoChildren", "\\Sent"],
    ["INBOX.Projekte", "\\HasNoChildren"],
  ];
  await withProtectionCheck({ mailboxes, capabilities: "IMAP4rev1 UIDPLUS SPECIAL-USE NAMESPACE", onCommand: namespace }, async (refusal) => {
    for (const mailbox of ["Sent", "Sent.", "INBOX.Sent"]) {
      assert.equal(await refusal(mailbox, "delete"), `Refusing to delete protected mailbox: ${mailbox} (WEB.DE marks it as \\Sent)`, mailbox);
    }
    assert.equal(await refusal("Projekte", "delete"), null);
  });
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
