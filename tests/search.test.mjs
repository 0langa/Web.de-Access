import assert from "node:assert/strict";
import test from "node:test";

import { createImapClient, filterIdsBySubject, packUidSet } from "../mcp/mail.mjs";
import { fakeConfig, startFakeImapServer } from "./helpers/fake-imap-server.mjs";

test("UID lists are packed into IMAP ranges", () => {
  assert.equal(packUidSet([1, 2, 3, 5, 7, 8]), "1:3,5,7:8");
  assert.equal(packUidSet([9, 4, 4, 5]), "4:5,9");
  assert.equal(packUidSet([42]), "42");
});

function expandUidSet(set) {
  return set.split(",").flatMap((range) => {
    const [start, end = start] = range.split(":").map(Number);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
}

// Subjects as a WEB.DE envelope carries them: RFC 2047 encoded words for
// non-ASCII text, plain ASCII otherwise.
function envelopeSubject(uid) {
  if (uid % 1000 === 0) {
    return "=?UTF-8?Q?[Rechnung]_Gr=C3=BC=C3=9Fe_aus_K=C3=B6ln?=";
  }
  return `Newsletter ${uid}`;
}

test("the subject filter decodes RFC 2047 subjects and keeps UID FETCH lines short", { timeout: 30000 }, async () => {
  const fetchLines = [];
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, args, write }) => {
      if (command === "UID FETCH") {
        fetchLines.push(`${tag} UID FETCH ${args}`);
        const [set] = args.split(" ");
        const lines = expandUidSet(set).map(
          (uid, index) => `* ${index + 1} FETCH (UID ${uid} ENVELOPE (NIL "${envelopeSubject(uid)}" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n`,
        );
        write(`${lines.join("")}${tag} OK FETCH completed\r\n`);
        return true;
      }
      return false;
    },
  });
  const client = createImapClient(fakeConfig({ imapPort: imap.port }), { doSTARTTLS: false });
  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });

    // Every second UID of a large mailbox, as a server-side search could return it.
    const ids = Array.from({ length: 5000 }, (_, index) => (index + 1) * 2);
    const matched = await filterIdsBySubject(client, ids, "grüße aus köln");

    assert.deepEqual(matched, [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
    // RFC 2683 asks servers to accept command lines of about 8000 octets; longer
    // ones are commonly rejected.
    assert.ok(Math.max(...fetchLines.map((line) => line.length)) < 8000);
  } finally {
    await client.logout().catch(() => {});
    await imap.close();
  }
});
