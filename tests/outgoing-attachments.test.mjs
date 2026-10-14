import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOutgoingAttachments } from "../mcp/mail.mjs";
import { fakeConfig } from "./helpers/fake-imap-server.mjs";

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webde-attachments-test-")));
  const allowed = path.join(root, "allowed");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(allowed);
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(allowed, "report.pdf"), "%PDF-1.7");
  fs.writeFileSync(path.join(elsewhere, "id_ed25519"), "not a real key");
  return { root, allowed, elsewhere };
}

test("allowedAttachmentRoots limits which local files can be attached", (t) => {
  const { root, allowed, elsewhere } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = fakeConfig({ allowedAttachmentRoots: [allowed] });

  const [attachment] = buildOutgoingAttachments([], [{ path: path.join(allowed, "report.pdf") }], config);
  assert.equal(attachment.filename, "report.pdf");
  assert.equal(attachment.path, path.join(allowed, "report.pdf"));

  for (const outside of [path.join(elsewhere, "id_ed25519"), path.join(allowed, "..", "elsewhere", "id_ed25519")]) {
    assert.throws(
      () => buildOutgoingAttachments([], [{ path: outside }], config),
      /outside the profile's allowedAttachmentRoots/,
    );
  }
});

test("a link inside an allowed root cannot reach a file outside it", (t) => {
  const { root, allowed, elsewhere } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A directory junction needs no extra privileges on Windows; elsewhere this
  // is an ordinary directory symlink.
  const link = path.join(allowed, "shared");
  fs.symlinkSync(elsewhere, link, "junction");

  assert.throws(
    () => buildOutgoingAttachments([], [{ path: path.join(link, "id_ed25519") }], fakeConfig({ allowedAttachmentRoots: [allowed] })),
    /outside the profile's allowedAttachmentRoots/,
  );
});

test("attachments over maxAttachmentMb are refused before sending", (t) => {
  const { root, allowed } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = fakeConfig({ maxAttachmentBytes: 4 });

  assert.throws(
    () => buildOutgoingAttachments([], [{ path: path.join(allowed, "report.pdf") }], config),
    /exceeds the profile's maxAttachmentMb limit/,
  );
  assert.throws(
    () => buildOutgoingAttachments([{ filename: "notes.txt", content: "12345" }], [], config),
    /exceeds the profile's maxAttachmentMb limit: notes\.txt/,
  );
  assert.equal(buildOutgoingAttachments([], [], config), undefined);
});
