import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDENTIAL_SERVICE = "webde-access";
export const DEFAULT_PROFILE = "personal";
export const DEFAULT_DEV_PROFILE = "dev";

export const legacySecretNames = [
  "WEBDE_PASSWORD",
  "WEBDE_APP_PASSWORD",
  "WEBDE_APP_PASSWORD_0langa",
  "WEBDE_APP_PASSWORD_Julius",
];

export function getConfigDir() {
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  return path.join(base, "webde-access");
}

export function getProfilesPath() {
  return path.join(getConfigDir(), "profiles.json");
}

export function credentialAccount(profile) {
  return `profile:${profile}`;
}

export function resolveProfileName(value = process.env.WEBDE_ACCESS_PROFILE) {
  const profile = value?.trim() || DEFAULT_PROFILE;
  if (!/^[a-zA-Z0-9._-]+$/.test(profile)) {
    throw new Error("WEBDE_ACCESS_PROFILE may contain only letters, numbers, dot, underscore, and dash.");
  }
  return profile;
}

export function defaultProfileConfig(profile, email = "") {
  return {
    profile,
    email,
    defaultFromName: "",
    folders: {
      inbox: "INBOX",
      sent: "Gesendet",
      drafts: "Entwurf",
      outbox: "Postausgang",
      trash: "Papierkorb",
      spam: "Spam",
      junk: "Junk-E-Mail",
      important: "wichtig",
    },
    attachmentDownloadDir: path.join(process.env.USERPROFILE || os.homedir(), "Downloads", "webde-attachments"),
    allowedAttachmentRoots: [],
    saveSentCopy: true,
    markReadOnFetch: false,
    maxFetchMessages: 50,
    maxAttachmentMb: 50,
    maxSourceMb: 15,
    imapHost: "imap.web.de",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.web.de",
    smtpPort: 587,
    smtpSecure: false,
  };
}

export function readProfiles() {
  const profilesPath = getProfilesPath();
  if (!fs.existsSync(profilesPath)) {
    return { profiles: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  return {
    profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
  };
}

export function writeProfiles(data) {
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const profilesPath = getProfilesPath();
  const content = `${JSON.stringify({ profiles: data.profiles || {} }, null, 2)}\n`;
  fs.writeFileSync(profilesPath, content, { encoding: "utf8", mode: 0o600 });
}

export function upsertProfile(profile, config) {
  const data = readProfiles();
  data.profiles[profile] = {
    ...defaultProfileConfig(profile),
    ...(data.profiles[profile] || {}),
    ...config,
    profile,
  };
  writeProfiles(data);
  return data.profiles[profile];
}

export function getStoredProfile(profile) {
  return readProfiles().profiles[profile] || null;
}

async function loadKeytar() {
  return (await import("keytar")).default;
}

export async function setProfilePassword(profile, password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must not be empty.");
  }
  const keytar = await loadKeytar();
  await keytar.setPassword(CREDENTIAL_SERVICE, credentialAccount(profile), password);
}

export async function getProfilePassword(profile) {
  const keytar = await loadKeytar();
  return keytar.getPassword(CREDENTIAL_SERVICE, credentialAccount(profile));
}

export async function deleteProfilePassword(profile) {
  const keytar = await loadKeytar();
  return keytar.deletePassword(CREDENTIAL_SERVICE, credentialAccount(profile));
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseBool(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function assertNoLegacySecretEnv() {
  const present = legacySecretNames.filter((name) => typeof process.env[name] === "string" && process.env[name].trim());
  if (present.length) {
    throw new Error(
      `Refusing to start with legacy WEB.DE secret environment variables present: ${present.join(
        ", ",
      )}. Import them with npm run auth:import-env, then remove them from the user environment.`,
    );
  }
}

export function assertNoLegacyDotEnv(pluginRoot) {
  const envPath = path.join(pluginRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, "utf8");
  if (/^\s*(WEBDE_PASSWORD|WEBDE_APP_PASSWORD)/m.test(content)) {
    throw new Error(
      `Refusing to start because ${envPath} contains legacy WEB.DE credentials. Import them into the OS credential manager and delete the file.`,
    );
  }
}

export async function loadRuntimeConfig(options = {}) {
  if (!options.allowLegacyEnv) {
    assertNoLegacySecretEnv();
    if (options.pluginRoot) {
      assertNoLegacyDotEnv(options.pluginRoot);
    }
  }

  const profile = resolveProfileName(options.profile);
  const stored = getStoredProfile(profile);
  if (!stored) {
    throw new Error(`WEB.DE profile '${profile}' is not configured. Run npm run auth:login -- --profile ${profile}.`);
  }

  const password = await getProfilePassword(profile);
  if (!password) {
    throw new Error(`WEB.DE profile '${profile}' has no OS credential. Run npm run auth:login -- --profile ${profile}.`);
  }

  const config = {
    ...defaultProfileConfig(profile),
    ...stored,
    profile,
    password,
  };

  if (!config.email || !String(config.email).includes("@")) {
    throw new Error(`WEB.DE profile '${profile}' has no valid email address.`);
  }

  return {
    profile,
    email: String(config.email).trim(),
    password,
    defaultFromName: String(config.defaultFromName || ""),
    folders: {
      ...defaultProfileConfig(profile).folders,
      ...(config.folders || {}),
    },
    attachmentDownloadDir: path.resolve(config.attachmentDownloadDir),
    allowedAttachmentRoots: (config.allowedAttachmentRoots || []).map((item) => path.resolve(String(item))),
    saveSentCopy: Boolean(config.saveSentCopy),
    markReadOnFetch: Boolean(config.markReadOnFetch),
    maxFetchMessages: parsePositiveInt(config.maxFetchMessages, "maxFetchMessages"),
    maxAttachmentBytes: parsePositiveInt(config.maxAttachmentMb, "maxAttachmentMb") * 1024 * 1024,
    maxSourceBytes: parsePositiveInt(config.maxSourceMb, "maxSourceMb") * 1024 * 1024,
    imapHost: String(config.imapHost || "imap.web.de"),
    imapPort: parsePositiveInt(config.imapPort, "imapPort"),
    imapSecure: Boolean(config.imapSecure),
    smtpHost: String(config.smtpHost || "smtp.web.de"),
    smtpPort: parsePositiveInt(config.smtpPort, "smtpPort"),
    smtpSecure: Boolean(config.smtpSecure),
  };
}

export function profileFromNonSecretEnv(profile, email) {
  const base = defaultProfileConfig(profile, email);
  return {
    ...base,
    defaultFromName: process.env.WEBDE_DEFAULT_FROM_NAME?.trim() || base.defaultFromName,
    folders: {
      inbox: process.env.WEBDE_INBOX_MAILBOX?.trim() || base.folders.inbox,
      sent: process.env.WEBDE_SENT_MAILBOX?.trim() || base.folders.sent,
      drafts: process.env.WEBDE_DRAFTS_MAILBOX?.trim() || base.folders.drafts,
      outbox: process.env.WEBDE_OUTBOX_MAILBOX?.trim() || base.folders.outbox,
      trash: process.env.WEBDE_TRASH_MAILBOX?.trim() || base.folders.trash,
      spam: process.env.WEBDE_SPAM_MAILBOX?.trim() || base.folders.spam,
      junk: process.env.WEBDE_JUNK_MAILBOX?.trim() || base.folders.junk,
      important: process.env.WEBDE_IMPORTANT_MAILBOX?.trim() || base.folders.important,
    },
    attachmentDownloadDir: process.env.WEBDE_ATTACHMENT_DOWNLOAD_DIR?.trim() || base.attachmentDownloadDir,
    allowedAttachmentRoots: (process.env.WEBDE_ALLOWED_ATTACHMENT_ROOTS || "")
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean),
    saveSentCopy: parseBool(process.env.WEBDE_SAVE_SENT_COPY, base.saveSentCopy),
    markReadOnFetch: parseBool(process.env.WEBDE_MARK_READ_ON_FETCH, base.markReadOnFetch),
    maxFetchMessages: process.env.WEBDE_MAX_FETCH_MESSAGES?.trim() || base.maxFetchMessages,
    maxAttachmentMb: process.env.WEBDE_MAX_ATTACHMENT_MB?.trim() || base.maxAttachmentMb,
    maxSourceMb: process.env.WEBDE_MAX_SOURCE_MB?.trim() || base.maxSourceMb,
    imapHost: process.env.WEBDE_IMAP_HOST?.trim() || base.imapHost,
    imapPort: process.env.WEBDE_IMAP_PORT?.trim() || base.imapPort,
    imapSecure: parseBool(process.env.WEBDE_IMAP_SECURE, base.imapSecure),
    smtpHost: process.env.WEBDE_SMTP_HOST?.trim() || base.smtpHost,
    smtpPort: process.env.WEBDE_SMTP_PORT?.trim() || base.smtpPort,
    smtpSecure: parseBool(process.env.WEBDE_SMTP_SECURE, base.smtpSecure),
  };
}
