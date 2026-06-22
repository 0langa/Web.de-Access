---
name: webde-drafts
description: Create or update draft emails in the user's WEB.DE account using the plugin's MCP tools.
---

# WEB.DE Drafts

Use this skill when the user wants to create a draft in a WEB.DE mailbox or send an email through WEB.DE.

## Workflow

1. If setup is not confirmed, remind the user to add credentials to the plugin's `.env` file.
2. Call `check_webde_connection` before the first draft attempt or after any credential change.
3. Call `create_webde_draft` to save a draft in the configured drafts folder.
4. Call `send_webde_email` only when the user explicitly wants the email sent.
5. Tell the user what happened and mention the configured drafts mailbox when relevant.

## Notes

- This plugin saves drafts through IMAP and sends mail through SMTP.
- It does not provide inbox-reading tools.
- WEB.DE application-specific passwords are the expected credential for external programs.
- `send_webde_email` can attach real files from disk by passing `fileAttachments` with file paths.
