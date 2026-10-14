import assert from "node:assert/strict";
import test from "node:test";

import { buildMessage } from "../mcp/mail.mjs";

test("line breaks in subjects, threading headers and attachment metadata cannot add headers", async () => {
  // Replies copy Message-ID and References from the original message, which
  // the sender of that message controls; subjects and attachment metadata
  // come from tool arguments.
  const raw = (
    await buildMessage({
      from: "user@example.test",
      to: ["friend@example.test"],
      subject: "Hello\r\nBcc: injected-subject@evil.test",
      text: "Body",
      headers: {
        "In-Reply-To": "<id@example.test>\r\nBcc: injected-reply@evil.test",
        References: "<a@example.test>\nX-Injected: references",
      },
      attachments: [
        {
          filename: "notes.txt\r\nX-Injected: filename",
          content: "attachment",
          contentType: "text/plain\r\nX-Injected: content-type",
        },
      ],
    })
  ).toString();

  const headerLines = raw.split("\r\n").filter((line) => /^[A-Za-z-]+:/.test(line));
  assert.deepEqual(
    headerLines.filter((line) => /^(Bcc|X-Injected):/i.test(line)),
    [],
  );
  assert.match(raw, /^Subject: Hello Bcc: injected-subject@evil\.test\r$/m);
});
