---
name: webde-access
description: Use this skill when the user wants private WEB.DE mailbox access, including reading, searching, drafting, sending, replying, forwarding, attachment handling, or mailbox/message management.
---

# WEB.DE Access (Claude Code)

Use this skill when the user wants to work with their WEB.DE mailbox from
Claude Code. The MCP server is the same one Codex uses
(`../../../mcp/server.mjs`, 20 tools) — nothing was duplicated for Claude
Code; the plugin manifest points at the same root-level `.mcp.json` Codex
uses.

For details beyond the normal workflow, use the shared reference docs (same
files Codex uses, not copies):

- [Configuration reference](../../../skills/webde-access/references/configuration.md)
- [Tool behavior reference](../../../skills/webde-access/references/tools.md)
- [Website workflow reference](../../../skills/webde-access/references/website-workflows.md)

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
8. Use `send_webde_email`, `reply_webde_email`, or `forward_webde_email` only when the user explicitly wants mail sent — treat these the same as any other irreversible, externally-visible action: confirm the recipients, subject, and intent in chat before calling the tool, every time, even if a similar send was approved earlier in the same session.
9. Use message mutation tools (`mark_webde_messages`, `move_webde_messages`, `delete_webde_messages`, mailbox create/rename/delete) only for the requested mailbox and UID values, and confirm before any delete or permanent-removal action.

## Mailbox Names

Prefer configured mailbox names from `.env` and live IMAP results over assumptions. Common WEB.DE
folders in this account are:

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
- Do not send email unless the user's request clearly asks for sending, and always state the recipients/subject back to the user before the send tool call.
- For ambiguous destructive requests, create a draft or summarize the intended action first, then ask before proceeding.
- Prefer moving messages to `Papierkorb` over permanent deletion unless permanent deletion is explicit.
- When attaching local files, pass file paths through `fileAttachments`; do not read large files into chat.
- Never read, print, or summarize the contents of the repository's `.env` file — mailbox credentials live there and must stay untouched by the assistant.

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
- If SMTP verification fails but IMAP works, re-check `WEBDE_SMTP_HOST`, `WEBDE_SMTP_PORT`, and STARTTLS settings.
- If attachment download fails, check `WEBDE_ATTACHMENT_DOWNLOAD_DIR` and `WEBDE_MAX_ATTACHMENT_MB`.
- If quota returns `null`, WEB.DE did not expose quota data over the current IMAP connection.

## Related

- Plugin README: `../../../README.md`
- Claude Code setup notes: `../../../README.md#claude-code`
- MCP server implementation (shared with Codex, not duplicated): `../../../mcp/server.mjs`
