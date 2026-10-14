import assert from "node:assert/strict";
import test from "node:test";

import { messageSummary } from "../mcp/mail.mjs";

test("a message with an unparseable Date header does not break search results", () => {
  // ImapFlow hands over the raw header text when it cannot parse a date,
  // which spam and broken mailers produce regularly.
  const summary = messageSummary({
    seq: 1,
    uid: 7,
    envelope: { date: "Freitag, 13. Okt 2026", subject: "Gewinnspiel" },
    internalDate: "not a date",
    flags: new Set(["\\Seen"]),
  });

  assert.equal(summary.uid, 7);
  assert.equal(summary.subject, "Gewinnspiel");
  assert.equal(summary.date, null);
  assert.equal(summary.internalDate, null);
  assert.deepEqual(summary.flags, ["\\Seen"]);
});

test("valid message dates are reported as ISO timestamps", () => {
  const summary = messageSummary({
    uid: 8,
    envelope: { date: new Date("2026-10-13T08:00:00Z") },
    internalDate: new Date("2026-10-13T08:00:05Z"),
  });

  assert.equal(summary.date, "2026-10-13T08:00:00.000Z");
  assert.equal(summary.internalDate, "2026-10-13T08:00:05.000Z");
});
