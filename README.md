# Web.de Access

Local email connector for using a Web.de mailbox from Codex, Claude Code, and Kimi Code through IMAP and SMTP. It can search
and read mail, download attachments, create drafts, send, reply, forward, manage flags, and organize
mailboxes. Credentials stay on the local machine and are never sent to a third-party service.

## Requirements

- A WEB.DE account with IMAP access enabled
- An application-specific WEB.DE password when required by the account
- Node.js 20.19 or newer
- Codex (CLI or desktop), Claude Code, or Kimi Code
- Git

## 1. Prepare WEB.DE

1. Sign in to WEB.DE in a browser.
2. Open the email settings and enable access through POP3/IMAP for external email programs.
3. If two-factor authentication is enabled, create an application-specific password for this
   connector. Prefer an app password over the normal account password whenever WEB.DE offers one.
4. Keep the generated password private. Do not paste it into issues, commits, screenshots, or chat.

WEB.DE's standard endpoints are:

| Service | Host | Port | Security |
| --- | --- | ---: | --- |
| IMAP | `imap.web.de` | 993 | SSL/TLS |
| SMTP | `smtp.web.de` | 587 | STARTTLS |

WEB.DE may change the names or location of settings. Consult the official
[WEB.DE Help Center](https://hilfe.web.de/) if an option is not visible.

## 2. Install

Clone the repository and install its pinned dependencies:

```powershell
git clone https://github.com/0langa/Web.de-Access.git
Set-Location "Web.de Access"
npm ci
```

On macOS or Linux, use `cd "Web.de Access"` instead of `Set-Location`.

## 3. Configure Credentials

Credentials are stored in the operating system credential manager through `keytar`, not in this
repository. Non-secret profile metadata is stored in:

```powershell
%APPDATA%\webde-access\profiles.json
```

Create or update a profile interactively:

```powershell
npm run auth:login -- --profile personal
```

For one-time migration from temporary user environment variables, import profiles without
printing app-password values:

```powershell
npm run auth:import-env -- --profile dev --email-env WEBDE_DEV_EMAIL --password-env WEBDE_DEV_APP_PASSWORD
npm run auth:import-env -- --profile personal --email-env WEBDE_MIGRATION_EMAIL --fallback-email-env WEBDE_MIGRATION_EMAIL_FALLBACK --password-env WEBDE_MIGRATION_APP_PASSWORD
npm run auth:status
```

If the personal email environment variable is missing or misspelled, pass it explicitly with
`--email`. Do not paste the app password into chat or commit history.

After both profiles validate, remove the temporary migration variables and old plugin `.env` files:

```powershell
npm run auth:cleanup-env -- --env WEBDE_DEV_EMAIL --env WEBDE_DEV_APP_PASSWORD --env WEBDE_MIGRATION_EMAIL --env WEBDE_MIGRATION_EMAIL_FALLBACK --env WEBDE_MIGRATION_APP_PASSWORD --purge-plugin-envs
npm run security:scan
```

The MCP server refuses to start when legacy WEB.DE password environment variables or plugin-local
`.env` credentials are present. That fail-closed behavior prevents accidental credential leaks
through repo copies, plugin caches, managed installs, or marketplace packaging.

### Profile settings

Each profile in `profiles.json` also holds the non-secret settings: folder names, the attachment
download directory, size limits, allowed attachment roots, and the IMAP/SMTP endpoints. See
[`profiles.example.json`](profiles.example.json) for every key and its default. The MCP server reads
these settings only from this file; the setting variables below, such as `WEBDE_SENT_MAILBOX`, have no
effect on a running server. `WEBDE_ACCESS_PROFILE` still selects which profile it uses.

`auth:login` and `auth:import-env` copy optional `WEBDE_*` variables into the profile when they are
set, for example `WEBDE_SENT_MAILBOX`, `WEBDE_ATTACHMENT_DOWNLOAD_DIR`, `WEBDE_MAX_ATTACHMENT_MB`,
`WEBDE_MAX_SOURCE_MB`, `WEBDE_ALLOWED_ATTACHMENT_ROOTS`, `WEBDE_SMTP_PORT` or `WEBDE_SMTP_SECURE`.
Settings whose variable is not set keep their stored value, so re-running `auth:login` to replace
an app password does not reset the rest of the profile. To change a setting later, edit
`profiles.json` directly or set the variable and run `auth:login` again.

With `imapSecure: false` the IMAP connection requires STARTTLS, and with `smtpSecure: false` SMTP
requires it as well, so the app password is never sent unencrypted.

## 4. Verify the Connection

Run the read-only checks:

```powershell
npm run check
npm run smoke -- --profile dev
npm run smoke -- --profile personal
```

`npm run smoke` connects to WEB.DE, lists the 20 exposed tools, checks IMAP and SMTP, reads quota
metadata, and reads one message summary. It does not send, delete, or move mail.

If a configured folder fails, note the exact names returned by `list_webde_mailboxes` and update the
matching profile metadata in `%APPDATA%\webde-access\profiles.json`. German WEB.DE accounts commonly
use `Gesendet`, `Entwurf`, and `Papierkorb`, but the server response is authoritative.

## 5. Add To Codex

Register the server using the absolute path to `mcp/server.mjs`.

Windows example:

```powershell
codex mcp add webde-access -- node "C:\absolute\path\to\Web.de Access\mcp\server.mjs"
```

macOS or Linux example:

```bash
codex mcp add webde-access -- node "/absolute/path/to/Web.de Access/mcp/server.mjs"
```

Restart Codex or open a new thread after registration. The server loads credentials from the OS
credential manager using the `personal` profile unless `WEBDE_ACCESS_PROFILE` is set.

The repository is also a Codex plugin bundle through `.codex-plugin/plugin.json` and `.codex-mcp.json`
for users who maintain a local Codex plugin marketplace.

## Claude Code

The repository is also an installable Claude Code plugin bundle through `.claude-plugin/plugin.json`
and `.claude-plugin/marketplace.json`, the same pattern as the Codex plugin bundle above. Complete
steps 1–4 above (WEB.DE setup, `npm ci`, profile login/import, `npm run smoke`), then:

```text
claude plugin marketplace add <path-to-Web.de-Access>
claude plugin install webde-access@webde-access-local
```

The Claude manifest declares `mcpServers` pointing at `.mcp.json` and `skills` pointing at the single
canonical [`skills/webde-access/SKILL.md`](skills/webde-access/SKILL.md), which documents all 20 tools
plus explicit confirm-before-send/delete guidance matching Claude Code's action-safety conventions.

There is deliberately **one** skill directory. Claude Code auto-discovers `skills/` at the plugin root
in addition to whatever the manifest declares, so a second provider-specific skill directory would
register the same skill twice — doubling its always-on token cost and leaving two copies in the picker
whose instructions can drift apart. All three providers point at `./skills/`.

Claude Code launches plugin MCP servers with the *session* working directory rather than the plugin
directory, so `.mcp.json` anchors both `cwd` and the launcher path on `${CLAUDE_PLUGIN_ROOT}`. Codex
resolves relative paths against the plugin root already and keeps its own `.codex-mcp.json`. Both
configs start the same `mcp/server.mjs`.

## Kimi Code

The repository includes `kimi.plugin.json` for Kimi Code. The Kimi manifest pins
`WEBDE_ACCESS_PROFILE=dev`, so Kimi uses the development mailbox by default.

Install or reload the plugin from Kimi:

```text
/plugins install <path-to-Web.de-Access>
/reload
```

The Kimi manifest points at the same `mcp/server.mjs` MCP server and the same canonical skill
instructions in `skills/webde-access/SKILL.md`. Do not switch Kimi to the `personal`
profile unless the user explicitly asks for that trust boundary change.

## Capabilities

- Verify IMAP/SMTP connectivity and inspect storage quota
- List mailboxes and mailbox status
- Search by sender, recipient, subject, text, date, flags, or UID
- Parse plain-text and HTML messages
- Download attachments and export complete `.eml` messages
- Create drafts with To, CC, BCC, Reply-To, HTML, text, and attachments
- Send messages with local-file or in-memory attachments
- Reply, reply-all, and forward while preserving threading headers
- Preserve BCC and Message-ID in drafts and sent copies
- Mark read/unread or star/unstar
- Copy, move, trash, or permanently delete messages
- Create, rename, subscribe, unsubscribe, and delete user mailboxes

Sending and destructive tools act on a real mailbox. Codex should send only after an explicit user
request and should prefer trash over permanent deletion unless permanent deletion is requested.

## Attachment Access

Outgoing attachment paths are resolved on the machine running the MCP server. The connector can
attach any regular file that the current operating-system user can read. This is intentionally
powerful: only run the plugin in an account and workspace you trust.

Downloaded filenames are sanitized and constrained to the profile's `attachmentDownloadDir`. The
profile limits `maxAttachmentMb` (attachments) and `maxSourceMb` (complete messages, used to export,
read, and forward them) apply as hard limits: a download or export that would exceed them fails and
leaves no partial file behind, `read_webde_message` reports `sourceTruncated` for a message it could
read only in part, and forwarding the original attachments of such a message is refused.

To restrict outgoing attachments to specific directories, list them in the profile's
`allowedAttachmentRoots` array, or set `WEBDE_ALLOWED_ATTACHMENT_ROOTS` before running
`auth:login` (separate multiple roots with `;` on Windows or `:` on macOS/Linux). Leave it empty to
allow any regular file readable by the current user. Symbolic links are resolved before the
allowlist check.

## Optional Live E2E Test

The E2E test creates a temporary draft, sends one real message, verifies BCC and Message-ID
persistence, and removes its WEB.DE draft and sent-copy artifacts. The recipient still receives the
message.

```powershell
$env:WEBDE_E2E_RECIPIENT="a-test-mailbox@example.com"
npm run e2e:email
```

Use only a mailbox you control. The recipient environment variable is process-local and is not
stored in the credential manager or profile metadata.

## Troubleshooting

### Authentication fails

- Confirm the full WEB.DE email address is used.
- Confirm POP3/IMAP access is enabled in WEB.DE.
- Create a fresh application-specific password and update the profile with `npm run auth:login`.
- Do not add quotes or trailing spaces around credentials unless they are part of the password.

### IMAP works but SMTP fails

- Keep `smtpPort: 587` and `smtpSecure: false` in the profile for STARTTLS.
- Check whether WEB.DE temporarily blocked external mail access after a security event.

### A message was sent but the Sent copy is missing

The send tools report `sentCopy.error` when SMTP accepted the message but saving the copy to the
profile's `folders.sent` failed. The message itself went out, so do not send it again; fix the
folder name in the profile instead.

### Drafts appear in the wrong folder

Run `list_webde_mailboxes` and choose the folder marked with IMAP special use `\\Drafts`. Set its
exact path as `folders.drafts` in the profile.

### Attachments fail

- Use an absolute local path.
- Confirm the server process can read the file.
- Increase `maxAttachmentMb` (attachments) or `maxSourceMb` (exporting, reading, or forwarding large
  messages) in the profile only when necessary.
- Confirm the download directory is writable.

## Development

The offline checks run in CI on every push and pull request. None of them touches a mailbox or the
OS credential store; the tests drive the IMAP code against a scripted server on `127.0.0.1` and
build outgoing mail in memory.

```powershell
npm ci
npm run check
npm test
npm run test:cold-start
npm run security:scan
npm audit --omit=dev --audit-level=high
```

`npm run smoke -- --profile dev` additionally checks a real mailbox read-only. Do not run
`npm run e2e:email` in CI without a dedicated test account and secret isolation.

### Fresh-install verification

All provider entrypoints bootstrap the locked dependencies. The package approves only `keytar@7.9.0` for its required native install script under npm 12's install-script policy. `npm run test:cold-start` verifies a fresh Kimi entrypoint, the native binary, and MCP tool discovery without accessing a mailbox.
