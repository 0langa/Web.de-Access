import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getProfilesPath, readProfiles, upsertProfile } from "../mcp/auth-config.mjs";
import { storeValidatedProfile } from "../scripts/store-profile.mjs";
import { startFakeImapServer } from "./helpers/fake-imap-server.mjs";

// Runs `work` against a fake server that answers LOGIN with `loginReply`
// (or accepts it), with profiles.json in a fresh directory and no WEBDE_*
// variables, so neither the real profiles nor the developer's environment are
// read or changed. `saved` records what auth:login would put into the OS
// credential store, instead of storing it.
async function withLogin(loginReply, work) {
  const imap = await startFakeImapServer({
    onCommand: ({ tag, command, write }) => {
      if (command !== "LOGIN" || !loginReply) {
        return false;
      }
      write(`${tag} ${loginReply}\r\n`);
      return true;
    },
  });
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "webde-access-login-"));
  const isOwnVariable = (name) => name === "APPDATA" || name.startsWith("WEBDE_");
  const previousEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => isOwnVariable(name)));
  for (const name of Object.keys(previousEnv)) {
    delete process.env[name];
  }
  process.env.APPDATA = appData;
  const saved = [];
  const login = (profile, email, password) =>
    storeValidatedProfile(profile, email, password, {
      // The fake server offers no TLS.
      imapOptions: { doSTARTTLS: false },
      savePassword: async (...args) => {
        saved.push(args);
      },
    });
  try {
    await work({ imap, saved, login });
  } finally {
    for (const name of Object.keys(process.env).filter(isOwnVariable)) {
      delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
    fs.rmSync(appData, { recursive: true, force: true });
    await imap.close();
  }
}

// ImapFlow marks the error of a LOGIN the server refuses.
const loginRefused = (error) => error.authenticationFailed === true;

// A profile that works, pointed at the fake server.
function storeWorkingProfile(imap) {
  upsertProfile("dev", { email: "dev@example.test", imapHost: "127.0.0.1", imapPort: imap.port, imapSecure: false, folders: { sent: "Sent" } });
}

test("a new app password that fails to log in changes neither the profile nor the stored password", { timeout: 15000 }, async () => {
  await withLogin("NO [AUTHENTICATIONFAILED] Authentication failed.", async ({ imap, saved, login }) => {
    storeWorkingProfile(imap);
    const before = fs.readFileSync(getProfilesPath(), "utf8");

    await assert.rejects(login("dev", "dev@example.test", "mistyped-app-password"), loginRefused);

    assert.deepEqual(saved, [], "the working app password must not be replaced");
    assert.equal(fs.readFileSync(getProfilesPath(), "utf8"), before);
    // The login was tried with the new password, not with the stored one.
    assert.match(imap.commands.find((entry) => entry.command === "LOGIN")?.args ?? "", /mistyped-app-password/);
  });
});

test("a first login that fails stores nothing", { timeout: 15000 }, async () => {
  await withLogin("NO [AUTHENTICATIONFAILED] Authentication failed.", async ({ imap, saved, login }) => {
    process.env.WEBDE_IMAP_HOST = "127.0.0.1";
    process.env.WEBDE_IMAP_PORT = String(imap.port);
    process.env.WEBDE_IMAP_SECURE = "false";

    await assert.rejects(login("dev", "dev@example.test", "mistyped-app-password"), loginRefused);

    assert.deepEqual(saved, []);
    assert.equal(fs.existsSync(getProfilesPath()), false);
  });
});

test("a new app password that logs in is stored, and the profile keeps its settings", { timeout: 15000 }, async () => {
  await withLogin(null, async ({ imap, saved, login }) => {
    storeWorkingProfile(imap);

    await login("dev", "dev@example.test", "new-app-password");

    assert.deepEqual(saved, [["dev", "new-app-password"]]);
    const stored = readProfiles().profiles.dev;
    assert.equal(stored.email, "dev@example.test");
    assert.equal(stored.folders.sent, "Sent");
    assert.equal(stored.imapPort, imap.port);
  });
});
