import assert from "node:assert/strict";
import test from "node:test";

import { assertDeletableMailbox } from "../mcp/mail.mjs";
import { fakeConfig } from "./helpers/fake-imap-server.mjs";

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
