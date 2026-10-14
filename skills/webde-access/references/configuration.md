# Web.de Access Configuration

The plugin stores WEB.DE app passwords in the operating system credential manager through `keytar`.
It stores non-secret profile metadata in `%APPDATA%\webde-access\profiles.json`.

Create a profile:

```powershell
npm run auth:login -- --profile personal
```

Import from temporary migration environment variables:

```powershell
npm run auth:import-env -- --profile dev --email-env WEBDE_DEV_EMAIL --password-env WEBDE_DEV_APP_PASSWORD
npm run auth:import-env -- --profile personal --email-env WEBDE_MIGRATION_EMAIL --fallback-email-env WEBDE_MIGRATION_EMAIL_FALLBACK --password-env WEBDE_MIGRATION_APP_PASSWORD
```

Never read, print, or copy WEB.DE app-password values. The MCP server refuses to start when legacy
plugin-local `.env` credentials or WEB.DE password environment variables are present.

Default WEB.DE protocol settings:

```json
{
  "imapHost": "imap.web.de",
  "imapPort": 993,
  "imapSecure": true,
  "smtpHost": "smtp.web.de",
  "smtpPort": 587,
  "smtpSecure": false
}
```

Mailbox settings should use exact IMAP folder names from `list_webde_mailboxes`:

```json
{
  "folders": {
    "inbox": "INBOX",
    "sent": "Gesendet",
    "drafts": "Entwurf",
    "outbox": "Postausgang",
    "trash": "Papierkorb",
    "spam": "Spam",
    "junk": "Junk-E-Mail",
    "important": "wichtig"
  }
}
```

Local file limits and defaults:

```json
{
  "defaultFromName": "Your Name",
  "attachmentDownloadDir": "%USERPROFILE%\\Downloads\\webde-attachments",
  "allowedAttachmentRoots": [],
  "saveSentCopy": true,
  "markReadOnFetch": false,
  "maxFetchMessages": 50,
  "maxAttachmentMb": 50,
  "maxSourceMb": 15
}
```

- `allowedAttachmentRoots`: directories outgoing `fileAttachments` must be inside; empty allows any
  file the OS user can read.
- `markReadOnFetch`: when `true`, reading, replying to, or forwarding a message marks it as read.
- `maxAttachmentMb` / `maxSourceMb`: hard limits for single attachments and complete messages;
  larger downloads and exports fail instead of being cut off.

The MCP server reads these settings only from the profile. `npm run auth:login` and
`npm run auth:import-env` copy optional `WEBDE_*` variables (for example `WEBDE_SENT_MAILBOX` or
`WEBDE_ALLOWED_ATTACHMENT_ROOTS`) into the profile when they are set and keep every other stored
setting. Setting such a variable for a running server has no effect.

WEB.DE setup requirements:

- POP3/IMAP access must be enabled in WEB.DE settings.
- If WEB.DE requests it, use an application-specific password instead of the normal login password.
- WEB.DE documents application-specific passwords for external email programs.
- SMTP uses STARTTLS on port 587 when `smtpSecure` is `false`.
