import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publicFiles = [
  "README.md",
  "mcp/auth-config.mjs",
  "scripts/smoke-test.mjs",
  "scripts/webde-auth.mjs",
  "skills/webde-access/references/configuration.md",
];

test("public files contain no user-specific identity or smoke metadata", () => {
  const content = publicFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const privateName = ["Ju", "lius"].join("");
  assert.doesNotMatch(content, new RegExp(privateName, "i"));
  assert.doesNotMatch(content, /firstUid|firstAttachmentParts/);
});
