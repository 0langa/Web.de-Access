import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoLegacyDotEnv,
  assertNoLegacySecretEnv,
  defaultProfileConfig,
  getProfilesPath,
  profileFromNonSecretEnv,
  readProfiles,
  resolveProfileName,
  upsertProfile,
} from "../mcp/auth-config.mjs";

test("profile metadata is stored outside the repo and never includes a password", () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "webde-access-test-"));
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    upsertProfile("dev", profileFromNonSecretEnv("dev", "dev@example.com"));
    const profilesPath = getProfilesPath();
    const raw = fs.readFileSync(profilesPath, "utf8");
    assert.equal(profilesPath, path.join(appData, "webde-access", "profiles.json"));
    assert.match(raw, /dev@example\.com/);
    assert.doesNotMatch(raw, /password/i);
    assert.equal(readProfiles().profiles.dev.email, "dev@example.com");
  } finally {
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test("profile names are constrained", () => {
  assert.equal(resolveProfileName("personal"), "personal");
  assert.throws(() => resolveProfileName("../bad"), /WEBDE_ACCESS_PROFILE/);
});

test("legacy WEB.DE secret environment variables fail closed", () => {
  const previous = process.env.WEBDE_APP_PASSWORD;
  process.env.WEBDE_APP_PASSWORD = "redacted-test-value";
  try {
    assert.throws(() => assertNoLegacySecretEnv(), /legacy WEB\.DE secret environment variables/);
  } finally {
    if (previous === undefined) {
      delete process.env.WEBDE_APP_PASSWORD;
    } else {
      process.env.WEBDE_APP_PASSWORD = previous;
    }
  }
});

test("plugin-local legacy .env credentials fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webde-access-env-"));
  try {
    fs.writeFileSync(path.join(root, ".env"), "WEBDE_PASSWORD=redacted\n");
    assert.throws(() => assertNoLegacyDotEnv(root), /legacy WEB\.DE credentials/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default profile config is non-secret", () => {
  const config = defaultProfileConfig("dev", "dev@example.com");
  assert.equal(config.email, "dev@example.com");
  assert.equal(Object.hasOwn(config, "password"), false);
});
