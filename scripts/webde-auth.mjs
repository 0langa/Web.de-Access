#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { ImapFlow } from "imapflow";

import {
  deleteProfilePassword,
  getProfilePassword,
  getProfilesPath,
  getStoredProfile,
  loadRuntimeConfig,
  profileFromNonSecretEnv,
  readProfiles,
  resolveProfileName,
  setProfilePassword,
  upsertProfile,
} from "../mcp/auth-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else if (args[key]) {
      args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
      index += 1;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function oneOrMany(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function commandHelp() {
  console.log(`WEB.DE auth manager

Commands:
  login       Store one profile in the OS credential manager
  import-env Import one profile from existing environment variables
  status      Show profile readiness without revealing secrets
  logout      Remove a profile credential
  cleanup-env Remove migration env vars and known legacy .env files

Examples:
  npm run auth:login -- --profile dev
  npm run auth:import-env -- --profile dev --email-env WEBDE_DEV_EMAIL_0langa --password-env WEBDE_APP_PASSWORD_0langa
  npm run auth:status
`);
}

async function promptSecret(prompt) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
    }

    function onData(buffer) {
      const text = buffer.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Interrupted."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\b" || char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function validateProfile(profile) {
  const config = await loadRuntimeConfig({ profile, allowLegacyEnv: true });
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    logger: false,
  });
  await client.connect();
  await client.logout().catch(() => {});
}

function getEnvByNames(names) {
  for (const name of names.filter(Boolean)) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return { name, value: value.trim() };
    }
  }
  return { name: names.filter(Boolean)[0] || "", value: "" };
}

async function importEnv(args) {
  const profile = resolveProfileName(args.profile);
  const emailNames = [args["email-env"], args["fallback-email-env"]].filter(Boolean);
  const passwordNames = [args["password-env"], args["fallback-password-env"]].filter(Boolean);

  const email = args.email?.trim() || getEnvByNames(emailNames).value;
  const password = getEnvByNames(passwordNames).value;

  if (!email) {
    throw new Error("No email found. Pass --email or --email-env.");
  }
  if (!password) {
    throw new Error("No password found. Pass --password-env pointing at the migration-only app password variable.");
  }

  upsertProfile(profile, profileFromNonSecretEnv(profile, email));
  await setProfilePassword(profile, password);
  await validateProfile(profile);
  console.log(`Imported and validated WEB.DE profile '${profile}'.`);
}

async function login(args) {
  const profile = resolveProfileName(args.profile);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const email = args.email?.trim() || (await rl.question("WEB.DE email: "));
    const password = args.password || (await promptSecret("WEB.DE app password: "));
    if (!email || !password) {
      throw new Error("Email and app password are required.");
    }
    upsertProfile(profile, profileFromNonSecretEnv(profile, email));
    await setProfilePassword(profile, password);
    await validateProfile(profile);
    console.log(`Stored and validated WEB.DE profile '${profile}'.`);
  } finally {
    rl.close();
  }
}

async function status() {
  const data = readProfiles();
  const profiles = Object.keys(data.profiles).sort();
  if (!profiles.length) {
    console.log("No WEB.DE profiles configured.");
    return;
  }
  for (const profile of profiles) {
    const stored = getStoredProfile(profile);
    const hasCredential = Boolean(await getProfilePassword(profile));
    console.log(
      JSON.stringify(
        {
          profile,
          emailConfigured: Boolean(stored?.email),
          credentialConfigured: hasCredential,
          configPath: getProfilesPath(),
        },
        null,
        2,
      ),
    );
  }
}

async function logout(args) {
  const profile = resolveProfileName(args.profile);
  await deleteProfilePassword(profile);
  console.log(`Removed OS credential for WEB.DE profile '${profile}'. Non-secret profile config remains.`);
}

function deleteUserEnvVar(name, dryRun) {
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing invalid environment variable name: ${name}`);
  }
  if (dryRun) {
    console.log(`[dry-run] Would remove user environment variable ${name}.`);
    return;
  }
  if (process.platform === "win32") {
    spawnSync("reg", ["delete", "HKCU\\Environment", "/v", name, "/f"], { stdio: "ignore" });
    return;
  }
  console.log(`Manual cleanup required for user environment variable ${name} on this OS.`);
}

function knownLegacyEnvFiles() {
  return [
    path.join(repoRoot, ".env"),
    path.join(process.env.USERPROFILE || "", ".kimi-code", "plugins", "managed", "webde-access", ".env"),
    path.join(process.env.USERPROFILE || "", ".codex", "plugins", "cache", "personal", "webde-access", ".env"),
    path.join(process.env.USERPROFILE || "", ".codex", "plugins", "cache", "personal", "webde-access", "0.2.0+codex.20260622150646", ".env"),
  ].filter(Boolean);
}

function cleanupEnv(args) {
  const dryRun = Boolean(args["dry-run"]);
  const envNames = oneOrMany(args.env);
  for (const name of envNames) {
    deleteUserEnvVar(name, dryRun);
  }

  if (args["purge-plugin-envs"]) {
    for (const file of knownLegacyEnvFiles()) {
      if (!fs.existsSync(file)) {
        continue;
      }
      if (dryRun) {
        console.log(`[dry-run] Would delete ${file}.`);
      } else {
        fs.rmSync(file, { force: true });
        console.log(`Deleted ${file}.`);
      }
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

try {
  if (!command || command === "help" || command === "--help") {
    commandHelp();
  } else if (command === "login") {
    await login(args);
  } else if (command === "import-env") {
    await importEnv(args);
  } else if (command === "status") {
    await status();
  } else if (command === "logout") {
    await logout(args);
  } else if (command === "cleanup-env") {
    cleanupEnv(args);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
