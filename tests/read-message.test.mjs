import assert from "node:assert/strict";
import test from "node:test";

import { createImapClient, fetchParsedMessage } from "../mcp/mail.mjs";
import { fakeConfig, fetchReply, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

const MESSAGE = Buffer.from("From: alice@example.test\r\nSubject: Hi\r\nMessage-ID: <hi@example.test>\r\n\r\nHello\r\n");

async function readWith(markReadOnFetch) {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, args, write }) => {
      if (command === "UID FETCH") {
        fetchReply({ tag, args, uid: 3, size: MESSAGE.length, sections: { "": MESSAGE }, write });
        return true;
      }
      if (command === "UID STORE") {
        write(`* 1 FETCH (UID 3 FLAGS (\\Seen))\r\n${tag} OK STORE completed\r\n`);
        return true;
      }
      return false;
    },
  });
  const config = fakeConfig({ imapPort: imap.port, markReadOnFetch });
  const client = createImapClient(config, { doSTARTTLS: false });
  try {
    await client.connect();
    const { msg, parsed } = await fetchParsedMessage(client, "INBOX", 3, config);
    return { msg, parsed, commands: imap.commands };
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
}

test("reading leaves the message unread by default", { timeout: 15000 }, async () => {
  const { parsed, commands } = await readWith(false);
  assert.equal(parsed.subject, "Hi");
  assert.ok(commands.some((entry) => entry.command === "EXAMINE"));
  assert.ok(!commands.some((entry) => entry.command === "UID STORE"));
});

test("markReadOnFetch marks the message as read", { timeout: 15000 }, async () => {
  const { msg, commands } = await readWith(true);
  const store = commands.find((entry) => entry.command === "UID STORE");
  assert.ok(store, "expected a STORE that sets \\Seen");
  assert.match(store.args, /^3 \+FLAGS(\.SILENT)? \(\\Seen\)$/);
  assert.ok(msg.flags.has("\\Seen"));
});
