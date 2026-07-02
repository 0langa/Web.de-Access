---
name: webde-access
description: Use this skill when the user wants private Web.de mailbox access, including reading, searching, drafting, sending, replying, forwarding, attachment handling, or mailbox/message management.
---

# Web.de Access

Use this skill when the user wants to work with their Web.de mailbox from Codex.

For details beyond the normal workflow, use:

- [Configuration reference](references/configuration.md)
- [Tool behavior reference](references/tools.md)
- [Website workflow reference](references/website-workflows.md)

## Capabilities

- Verify WEB.DE IMAP/SMTP connectivity.
- List mailboxes and inspect mailbox status/counts.
- Inspect server-reported mailbox storage quota.
- Search messages by text, sender, recipient, subject, date, flags, or UID.
- Read parsed message bodies and attachment metadata.
- Download message attachments to the configured local folder.
- Export full messages as local `.eml` files.
- Create drafts with To, CC, BCC, Reply-To, HTML/text, and local file attachments.
- Send, reply, reply-all, and forward mail through WEB.DE SMTP.
- Move, copy, delete, mark read/unread, and star/unstar messages.
- Create, rename, subscribe/unsubscribe, and delete user mailboxes.

## Workflow

1. If the user asks about setup or a connection looks stale, call `check_webde_connection`.
2. Use `list_webde_mailboxes` when mailbox names are unknown; WEB.DE folder names may be German.
3. Use `search_webde_messages` before reading messages unless the user already provided a mailbox and UID.
4. Use `read_webde_message` for message content. Ask for or infer `includeHtml` only when raw HTML is needed.
5. Use `download_webde_attachment` for attachment files. Do not inline large attachment content in chat.
6. Use `export_webde_message` when the user wants a raw `.eml` copy for backup or manual import.
7. Use `create_webde_draft` when the user wants to review before sending.
8. Use `send_webde_email`, `reply_webde_email`, or `forward_webde_email` only when the user explicitly wants mail sent.
9. Use message mutation tools only for the requested mailbox and UID values.

## Mailbox Names

Prefer configured profile metadata and live IMAP results over assumptions. Common WEB.DE folders in
this account are:

```text
INBOX
Gesendet
Entwürfe
Entwurf
Papierkorb
Spam
Junk-E-Mail
Postausgang
Unbekannt
wichtig
```

## Safety

- Treat this as a private mailbox connector with real account access.
- Do not send email unless the user's request clearly asks for sending.
- For ambiguous destructive requests, create a draft or summarize the intended action first.
- Prefer moving messages to `Papierkorb` over permanent deletion unless permanent deletion is explicit.
- When attaching local files, pass file paths through `fileAttachments`; do not read large files into chat.
- Never read, print, or summarize `.env`, WEB.DE app-password environment variables, or OS credential
  data. Credentials are managed by `npm run auth:*` and the operating system credential manager.

## Examples

Search unread inbox mail:

```json
{
  "mailbox": "INBOX",
  "unseen": true,
  "limit": 20
}
```

Send a message with CC, BCC, and a local attachment:

```json
{
  "to": ["person@example.com"],
  "cc": ["copy@example.com"],
  "bcc": ["hidden@example.com"],
  "subject": "Documents",
  "text": "Hi, attached are the files.",
  "fileAttachments": [
    { "path": "C:\\path\\to\\document.pdf" }
  ]
}
```

Reply to a message:

```json
{
  "mailbox": "INBOX",
  "uid": 12345,
  "text": "Thanks, I will check this and get back to you.",
  "replyAll": true
}
```

## Troubleshooting

- If authentication fails, confirm WEB.DE POP3/IMAP access is enabled and use an application-specific password if WEB.DE requests one.
- If a folder fails to open, call `list_webde_mailboxes` and update the mailbox name to the exact IMAP path.
- If SMTP verification fails but IMAP works, re-check the profile SMTP host, port, and STARTTLS settings.
- If attachment download fails, check the profile attachment directory and max attachment size.
- If quota returns `null`, WEB.DE did not expose quota data over the current IMAP connection.

## Related

- Plugin README: `../../README.md`
- MCP server implementation: `../../mcp/server.mjs`
