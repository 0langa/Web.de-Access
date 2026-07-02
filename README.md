# WEB.DE Access

Local email connector for using a WEB.DE mailbox from Codex through IMAP and SMTP. It can search
and read mail, download attachments, create drafts, send, reply, forward, manage flags, and organize
mailboxes. Credentials stay on the local machine and are never sent to a third-party service.

## Requirements

- A WEB.DE account with IMAP access enabled
- An application-specific WEB.DE password when required by the account
- Node.js 20 or newer
- Codex CLI or Codex desktop
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
git clone https://github.com/0langa/WebDE-Codex-Plugin.git
Set-Location WebDE-Codex-Plugin
npm ci
```

On macOS or Linux, use `cd WebDE-Codex-Plugin` instead of `Set-Location`.

## 3. Configure Credentials

Create a private `.env` from the safe template:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux:

```bash
cp .env.example .env
```

Edit only the local `.env` and set:

```env
WEBDE_EMAIL=your-address@web.de
WEBDE_PASSWORD=replace-with-your-app-password
WEBDE_DEFAULT_FROM_NAME=Your Name
```

The repository ignores `.env` and `.env.*`; `.env.example` is the only environment file intended
for Git. Never remove those ignore rules or commit a real credential file.

Most accounts can keep the remaining defaults. `WEBDE_ATTACHMENT_DOWNLOAD_DIR` may be left empty;
downloads then go to `Downloads/webde-attachments` under the current user profile.

## 4. Verify the Connection

Run the read-only checks:

```powershell
npm run check
npm run smoke
```

`npm run smoke` connects to WEB.DE, lists the 20 exposed tools, checks IMAP and SMTP, reads quota
metadata, and reads one message summary. It does not send, delete, or move mail.

If a configured folder fails, note the exact names returned by `list_webde_mailboxes` and update the
matching `WEBDE_*_MAILBOX` value in `.env`. German WEB.DE accounts commonly use `Gesendet`,
`Entwurf`, and `Papierkorb`, but the server response is authoritative.

## 5. Add To Codex

Register the server using the absolute path to `mcp/server.mjs`.

Windows example:

```powershell
codex mcp add webde-access -- node "C:\absolute\path\to\WebDE-Codex-Plugin\mcp\server.mjs"
```

macOS or Linux example:

```bash
codex mcp add webde-access -- node "/absolute/path/to/WebDE-Codex-Plugin/mcp/server.mjs"
```

Restart Codex or open a new thread after registration. The server loads `.env` from the repository
root automatically.

The repository is also a Codex plugin bundle through `.codex-plugin/plugin.json` and `.mcp.json` for
users who maintain a local Codex plugin marketplace.

## Claude Code

The repository is also an installable Claude Code plugin bundle through `.claude-plugin/plugin.json`
and `.claude-plugin/marketplace.json`, the same pattern as the Codex plugin bundle above. Complete
steps 1–4 above (WEB.DE setup, `npm ci`, `.env` from `.env.example`, `npm run smoke`), then:

```text
claude plugin marketplace add <path-to-WebDE-Codex-Plugin>
claude plugin install webde-access@webde-access-local
```

The plugin manifest declares `mcpServers` pointing at the same root-level `.mcp.json` Codex uses (no
new server, no duplicated config) and `skills` pointing at [`claude-code/skills/webde-access/SKILL.md`](claude-code/skills/webde-access/SKILL.md),
a Claude Code-specific skill file documenting the same 20 tools as the Codex skill plus explicit
confirm-before-send/delete guidance matching Claude Code's own action-safety conventions. This skill
lives outside `.claude/` deliberately — that path is reserved for project-level auto-discovery, and a
plugin manifest declaring a skill already covered by project auto-discovery fails to load (the same
class of conflict Claude Code reports as "Duplicate hooks file detected" for hook manifests).

No code in `mcp/server.mjs` or `.mcp.json` changed for Claude Code support — it is the same server
and config Codex uses.

## Kimi Code

The repository includes `kimi.plugin.json` for Kimi Code. Kimi installs local plugins by copying the
plugin directory into `C:\Users\Julius\.kimi-code\plugins\managed\<id>`, so never install a copy that
contains a real `.env` file unless you intentionally want that mailbox available to Kimi.

For development, use a dedicated test mailbox and create the managed-copy `.env` from development
environment variables only. Then install or reload the plugin from Kimi:

```text
/plugins install <path-to-WebDE-Codex-Plugin>
/reload
```

The Kimi manifest points at the same `mcp/server.mjs` MCP server and the stricter Claude/Kimi skill
instructions in `claude-code/skills/webde-access/SKILL.md`.

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

Downloaded filenames are sanitized and constrained to `WEBDE_ATTACHMENT_DOWNLOAD_DIR`. Limits are
controlled with `WEBDE_MAX_ATTACHMENT_MB` and `WEBDE_MAX_SOURCE_MB`.

To restrict outgoing attachments to specific directories, set `WEBDE_ALLOWED_ATTACHMENT_ROOTS`.
Separate multiple roots with `;` on Windows or `:` on macOS/Linux. Leave it empty to allow any
regular file readable by the current user. Symbolic links are resolved before the allowlist check.

## Optional Live E2E Test

The E2E test creates a temporary draft, sends one real message, verifies BCC and Message-ID
persistence, and removes its WEB.DE draft and sent-copy artifacts. The recipient still receives the
message.

```powershell
$env:WEBDE_E2E_RECIPIENT="a-test-mailbox@example.com"
npm run e2e:email
```

Use only a mailbox you control. The environment variable is process-local and is not written to
`.env` by the test.

## Troubleshooting

### Authentication fails

- Confirm the full WEB.DE email address is used.
- Confirm POP3/IMAP access is enabled in WEB.DE.
- Create a fresh application-specific password and update only the local `.env`.
- Do not add quotes or trailing spaces around credentials unless they are part of the password.

### IMAP works but SMTP fails

- Keep `WEBDE_SMTP_PORT=587` and `WEBDE_SMTP_SECURE=false` for STARTTLS.
- Check whether WEB.DE temporarily blocked external mail access after a security event.

### Drafts appear in the wrong folder

Run `list_webde_mailboxes` and choose the folder marked with IMAP special use `\\Drafts`. Set its
exact path as `WEBDE_DRAFTS_MAILBOX`.

### Attachments fail

- Use an absolute local path.
- Confirm the server process can read the file.
- Increase `WEBDE_MAX_ATTACHMENT_MB` only when necessary.
- Confirm the download directory is writable.

## Development

```powershell
npm ci
npm run check
npm run smoke
```

Do not run `npm run e2e:email` in CI without a dedicated test account and secret isolation.
