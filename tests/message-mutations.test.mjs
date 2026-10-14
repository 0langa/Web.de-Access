import assert from "node:assert/strict";
import test from "node:test";

import { copyMessages, createImapClient, deleteMessages, markMessages, moveMessages } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

// `replies` maps a command ("UID MOVE") to the tagged status the server answers
// with, or to a function that returns the complete answer for a tag.
async function inMailbox(capabilities, replies, work) {
  const imap = await startFakeImapServer({
    capabilities,
    onCommand: ({ tag, command, write }) => {
      const reply = replies[command];
      if (!reply) {
        return false;
      }
      write(typeof reply === "function" ? reply(tag) : `${tag} ${reply}\r\n`);
      return true;
    },
  });
  const config = fakeConfig({ imapPort: imap.port });
  const client = createImapClient(config, { doSTARTTLS: false });
  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    const outcome = await work(client, config).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    return { ...outcome, commands: imap.commands.map((entry) => `${entry.command} ${entry.args}`) };
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
}

const move = { sourceMailbox: "INBOX", destinationMailbox: "Archiv", uids: [7] };

test("a move into a folder that does not exist is reported as failed", { timeout: 15000 }, async () => {
  const { error } = await inMailbox("IMAP4rev1 UIDPLUS MOVE", { "UID MOVE": "NO [TRYCREATE] Mailbox does not exist" }, (client) =>
    moveMessages(client, move),
  );
  assert.match(error?.message ?? "", /did not move the messages from INBOX to Archiv/);
});

test("trash, copy and flag changes report failures instead of success", { timeout: 15000 }, async () => {
  const replies = { "UID MOVE": "NO move failed", "UID COPY": "NO copy failed", "UID STORE": "NO store failed" };
  const trash = await inMailbox("IMAP4rev1 UIDPLUS MOVE", replies, (client, config) =>
    deleteMessages(client, config, { mailbox: "INBOX", uids: [7], permanent: false }),
  );
  assert.match(trash.error?.message ?? "", /did not move the messages from INBOX to Papierkorb/);

  const copy = await inMailbox("IMAP4rev1 UIDPLUS MOVE", replies, (client) => copyMessages(client, move));
  assert.match(copy.error?.message ?? "", /did not copy the messages from INBOX to Archiv/);

  const mark = await inMailbox("IMAP4rev1 UIDPLUS MOVE", replies, (client) =>
    markMessages(client, { mailbox: "INBOX", uids: [7], action: "read" }),
  );
  assert.match(mark.error?.message ?? "", /did not confirm marking the messages in INBOX as read/);
});

test("without MOVE, a failed copy leaves the originals untouched", { timeout: 15000 }, async () => {
  const { error, commands } = await inMailbox("IMAP4rev1 UIDPLUS", { "UID COPY": "NO [TRYCREATE] Mailbox does not exist" }, (client) =>
    moveMessages(client, move),
  );
  assert.match(error?.message ?? "", /did not move/);
  assert.deepEqual(
    commands.filter((line) => /STORE|EXPUNGE/.test(line)),
    [],
    "ImapFlow's own fallback would flag and expunge the originals here",
  );
});

test("without MOVE, a copy is followed by an expunge of exactly the moved UIDs", { timeout: 15000 }, async () => {
  const { value, commands } = await inMailbox(
    "IMAP4rev1 UIDPLUS",
    { "UID COPY": "OK [COPYUID 1 7 70] COPY completed", "UID STORE": "OK STORE completed", "UID EXPUNGE": "OK EXPUNGE completed" },
    (client) => moveMessages(client, move),
  );
  assert.deepEqual(value?.uidMap, { 7: 70 });
  assert.ok(commands.includes("UID EXPUNGE 7"));
});

test("a move that would need a mailbox-wide expunge is refused", { timeout: 15000 }, async () => {
  const { error, commands } = await inMailbox("IMAP4rev1", {}, (client) => moveMessages(client, move));
  assert.match(error?.message ?? "", /supports neither MOVE nor UIDPLUS/);
  assert.deepEqual(commands.filter((line) => /COPY|STORE|EXPUNGE/.test(line)), []);
});

test("a failed permanent delete clears the \\Deleted flag again", { timeout: 15000 }, async () => {
  const { error, commands } = await inMailbox(
    "IMAP4rev1 UIDPLUS",
    { "UID STORE": "OK STORE completed", "UID EXPUNGE": "NO expunge failed" },
    (client, config) => deleteMessages(client, config, { mailbox: "INBOX", uids: [7], permanent: true }),
  );
  assert.match(error?.message ?? "", /did not confirm the expunge in INBOX; the messages were left in place/);
  assert.ok(commands.some((line) => /^UID STORE 7 -FLAGS/.test(line)), commands.join("\n"));
});

// A mailbox whose PERMANENTFLAGS do not include \Deleted, as on a shared or
// otherwise restricted folder. ImapFlow does not even send such a STORE.
const selectWithoutDeleted = (tag) =>
  "* FLAGS (\Answered \Flagged \Deleted \Seen \Draft)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n" +
  "* OK [PERMANENTFLAGS (\Seen \Flagged)] Limited\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n" +
  `${tag} OK [READ-WRITE] SELECT completed\r\n`;

test("a permanent delete whose \Deleted flag does not take reports that nothing was removed", { timeout: 15000 }, async () => {
  // ImapFlow's messageDelete() ignores its own STORE and expunges anyway. The
  // UID EXPUNGE then succeeds without removing anything, and the messages
  // were reported as permanently deleted.
  for (const replies of [
    { "UID STORE": "NO [CANNOT] Flags cannot be changed", "UID EXPUNGE": "OK EXPUNGE completed" },
    { SELECT: selectWithoutDeleted, "UID STORE": "OK STORE completed", "UID EXPUNGE": "OK EXPUNGE completed" },
  ]) {
    const { error, commands } = await inMailbox("IMAP4rev1 UIDPLUS", replies, (client, config) =>
      deleteMessages(client, config, { mailbox: "INBOX", uids: [7], permanent: true }),
    );
    assert.match(error?.message ?? "", /did not confirm flagging the messages in INBOX as deleted, so nothing was removed/);
    assert.deepEqual(commands.filter((line) => /EXPUNGE/.test(line)), [], commands.join("\n"));
  }
});

test("without MOVE, originals that cannot be removed after the copy are reported as now in both folders", { timeout: 15000 }, async () => {
  const copied = "OK [COPYUID 1 7 70] COPY completed";
  for (const [step, replies] of [
    ["flag", { "UID COPY": copied, "UID STORE": "NO store failed", "UID EXPUNGE": "OK EXPUNGE completed" }],
    ["expunge", { "UID COPY": copied, "UID STORE": "OK STORE completed", "UID EXPUNGE": "NO expunge failed" }],
  ]) {
    const { value, error } = await inMailbox("IMAP4rev1 UIDPLUS", replies, (client) => moveMessages(client, move));
    // Reported as a plain failure, a retry would copy the messages again.
    assert.equal(value, undefined, `a failed ${step} must not be reported as a move`);
    assert.match(
      error?.message ?? "",
      /^Copied the messages from INBOX to Archiv, but the originals could not be removed from INBOX, so they are now in both folders\. /,
      step,
    );
  }
});
