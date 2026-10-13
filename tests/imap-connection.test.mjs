import assert from "node:assert/strict";
import test from "node:test";

import { describeError, withImapConnection } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

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
      withImapConnection(config, (client) => client.mailboxOpen("INBOX", { readOnly: true })),
      (error) => {
        assert.match(describeError(error), /Literal size 2147483648 exceeds/);
        return true;
      },
    );
  } finally {
    await imap.close();
  }
});
