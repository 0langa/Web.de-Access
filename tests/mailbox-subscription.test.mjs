import assert from "node:assert/strict";
import test from "node:test";

import { createImapClient, setMailboxSubscription } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

// Runs set_webde_mailbox_subscription's change against a server that answers
// SUBSCRIBE and UNSUBSCRIBE with the tagged status `reply`.
async function changeSubscription(reply, subscribed) {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, write }) => {
      if (command === "SUBSCRIBE" || command === "UNSUBSCRIBE") {
        write(`${tag} ${reply}\r\n`);
        return true;
      }
      return false;
    },
  });
  const config = fakeConfig({ imapPort: imap.port });
  const client = createImapClient(config, { doSTARTTLS: false });
  try {
    await client.connect();
    const outcome = await setMailboxSubscription(client, { mailbox: "Projekte", subscribed }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    return { ...outcome, commands: imap.commands.map((entry) => `${entry.command} ${entry.args}`) };
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
}

test("a subscription change WEB.DE refuses is reported as failed", { timeout: 15000 }, async () => {
  for (const reply of ["NO [NONEXISTENT] Mailbox does not exist", "BAD Error in IMAP command: Invalid mailbox name"]) {
    const subscribe = await changeSubscription(reply, true);
    assert.equal(subscribe.value, undefined, `SUBSCRIBE answered ${reply} must not read as done`);
    assert.match(subscribe.error?.message ?? "", /^WEB\.DE did not confirm subscribing to Projekte\./);

    const unsubscribe = await changeSubscription(reply, false);
    assert.equal(unsubscribe.value, undefined, `UNSUBSCRIBE answered ${reply} must not read as done`);
    assert.match(unsubscribe.error?.message ?? "", /^WEB\.DE did not confirm unsubscribing from Projekte\./);
  }
});

test("a subscription change the server confirms is reported as done", { timeout: 15000 }, async () => {
  for (const subscribed of [true, false]) {
    const { value, error, commands } = await changeSubscription("OK completed", subscribed);
    assert.equal(error, undefined);
    assert.deepEqual(value, { mailbox: "Projekte", subscribed, ok: true });
    assert.ok(commands.includes(`${subscribed ? "SUBSCRIBE" : "UNSUBSCRIBE"} Projekte`), commands.join("\n"));
  }
});
