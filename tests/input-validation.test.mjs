import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { isBodyPartNumber, isImapSearchDate, isUidSet } from "../mcp/mail.mjs";

test("search dates must be calendar dates that IMAP can compare exactly", () => {
  for (const value of ["2026-10-13", "2024-02-29"]) {
    assert.equal(isImapSearchDate(value), true, value);
  }
  // ImapFlow drops a date it cannot parse without an error, and formats other
  // than YYYY-MM-DD are parsed in local time and can shift the day.
  for (const value of ["13.10.2026", "last friday", "October 13, 2026", "10/13/2026", "1", "2026-02-30", "2026-10-13T00:00:00+02:00", ""]) {
    assert.equal(isImapSearchDate(value), false, value);
  }
});

test("UID sets and body part numbers use the IMAP grammar", () => {
  for (const value of ["42", "40:50", "1:*", "3,7,10:12"]) {
    assert.equal(isUidSet(value), true, value);
  }
  for (const value of ["", "abc", "1 OR ALL", "1,", "1:2:3", "-5"]) {
    assert.equal(isUidSet(value), false, value);
  }
  for (const value of ["1", "2", "1.2", "3.1.4"]) {
    assert.equal(isBodyPartNumber(value), true, value);
  }
  for (const value of ["", "TEXT", "1.MIME", "2]", "1..2", "../2"]) {
    assert.equal(isBodyPartNumber(value), false, value);
  }
});

test("the MCP server rejects an unusable search date before touching a mailbox", { timeout: 15000 }, async () => {
  // An empty profile directory: should validation ever let the call through,
  // the server stops at "profile is not configured" and never reaches the
  // credential store or the network.
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "webde-access-validation-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    cwd: process.cwd(),
    env: { ...process.env, APPDATA: appData },
    stderr: "pipe",
  });
  const client = new Client({ name: "webde-validation-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "search_webde_messages",
      arguments: { mailbox: "INBOX", before: "13.10.2026" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /YYYY-MM-DD/);
    assert.doesNotMatch(result.content[0].text, /not configured/);
  } finally {
    await client.close();
    fs.rmSync(appData, { recursive: true, force: true });
  }
});
