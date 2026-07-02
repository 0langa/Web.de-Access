# Web.de Access Configuration

The plugin stores WEB.DE app passwords in the operating system credential manager through `keytar`.
It stores non-secret profile metadata in `%APPDATA%\webde-access\profiles.json`.

Create a profile:

```powershell
npm run auth:login -- --profile personal
```

Import from temporary migration environment variables:

```powershell
npm run auth:import-env -- --profile dev --email-env WEBDE_DEV_EMAIL_0langa --password-env WEBDE_APP_PASSWORD_0langa
npm run auth:import-env -- --profile personal --email-env WEBDE_IMPORTANT_EMAIL_Julius --fallback-email-env WEBDE_IMPORTENT_EMAIL_Julius --password-env WEBDE_APP_PASSWORD_Julius
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

WEB.DE setup requirements:

- POP3/IMAP access must be enabled in WEB.DE settings.
- If WEB.DE requests it, use an application-specific password instead of the normal login password.
- WEB.DE documents application-specific passwords for external email programs.
- SMTP uses STARTTLS on port 587 when `smtpSecure` is `false`.
