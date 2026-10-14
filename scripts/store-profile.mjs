import {
  getStoredProfile,
  mergeProfile,
  profileFromNonSecretEnv,
  runtimeConfig,
  setProfilePassword,
  upsertProfile,
} from "../mcp/auth-config.mjs";
import { withImapConnection } from "../mcp/mail.mjs";

// Logs in with the new settings and app password before anything is stored,
// so a mistyped password cannot replace one that works. Tests pass
// `savePassword` and `imapOptions` so they never reach the OS credential
// store or need TLS.
export async function storeValidatedProfile(profile, email, password, { savePassword = setProfilePassword, imapOptions } = {}) {
  const settings = profileFromNonSecretEnv(profile, email);
  const candidate = runtimeConfig(profile, mergeProfile(profile, getStoredProfile(profile), settings), password);
  await withImapConnection(candidate, async () => {}, imapOptions);
  upsertProfile(profile, settings);
  await savePassword(profile, password);
}
