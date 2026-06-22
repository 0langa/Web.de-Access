# WEB.DE Access Configuration

The plugin reads `.env` from the plugin root. The required values are:

```env
WEBDE_EMAIL=you@web.de
WEBDE_PASSWORD=application-specific-password
```

Default WEB.DE protocol settings:

```env
WEBDE_IMAP_HOST=imap.web.de
WEBDE_IMAP_PORT=993
WEBDE_IMAP_SECURE=true
WEBDE_SMTP_HOST=smtp.web.de
WEBDE_SMTP_PORT=587
WEBDE_SMTP_SECURE=false
```

Mailbox settings should use exact IMAP folder names from `list_webde_mailboxes`:

```env
WEBDE_INBOX_MAILBOX=INBOX
WEBDE_SENT_MAILBOX=Gesendet
WEBDE_DRAFTS_MAILBOX=Entwurf
WEBDE_OUTBOX_MAILBOX=Postausgang
WEBDE_TRASH_MAILBOX=Papierkorb
WEBDE_SPAM_MAILBOX=Spam
WEBDE_JUNK_MAILBOX=Junk-E-Mail
WEBDE_IMPORTANT_MAILBOX=wichtig
```

Local file limits and defaults:

```env
WEBDE_DEFAULT_FROM_NAME=Your Name
WEBDE_ATTACHMENT_DOWNLOAD_DIR=
WEBDE_ALLOWED_ATTACHMENT_ROOTS=
WEBDE_SAVE_SENT_COPY=true
WEBDE_MARK_READ_ON_FETCH=false
WEBDE_MAX_FETCH_MESSAGES=50
WEBDE_MAX_ATTACHMENT_MB=50
WEBDE_MAX_SOURCE_MB=15
```

WEB.DE setup requirements:

- POP3/IMAP access must be enabled in WEB.DE settings.
- If WEB.DE requests it, use an application-specific password instead of the normal login password.
- WEB.DE documents application-specific passwords for external email programs.
- SMTP uses STARTTLS on port 587 when `WEBDE_SMTP_SECURE=false`.
