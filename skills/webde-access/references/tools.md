# WEB.DE Access Tool Behavior

Read-only tools:

- `check_webde_connection`: verifies IMAP, configured folders, and SMTP.
- `list_webde_mailboxes`: lists exact IMAP folder paths.
- `get_webde_mailbox_status`: returns count and UID metadata for one mailbox.
- `get_webde_quota`: returns IMAP quota data when WEB.DE exposes it.
- `search_webde_messages`: returns message summaries with UID, envelope, flags, size, and downloadable parts.
- `read_webde_message`: parses a message into plain text, optional HTML, addresses, references, and attachment metadata.

Local export/download tools:

- `download_webde_attachment`: saves one IMAP body part to `WEBDE_ATTACHMENT_DOWNLOAD_DIR`.
- `export_webde_message`: saves a complete raw `.eml` file to `WEBDE_ATTACHMENT_DOWNLOAD_DIR`.

Sending tools:

- `create_webde_draft`: appends a draft to `WEBDE_DRAFTS_MAILBOX` with optional local file attachments.
- `send_webde_email`: sends via SMTP and can append a sent copy to `WEBDE_SENT_MAILBOX`.
- `reply_webde_email`: infers reply recipients and sets threading headers when available.
- `forward_webde_email`: forwards message content and can include original attachments.

Message mutation tools:

- `mark_webde_messages`: read, unread, star, or unstar by UID.
- `move_webde_messages`: move UIDs to another mailbox.
- `copy_webde_messages`: copy UIDs to another mailbox.
- `delete_webde_messages`: move to trash by default, or permanently delete when explicit.

Mailbox mutation tools:

- `create_webde_mailbox`: create a user folder.
- `rename_webde_mailbox`: rename a user folder.
- `set_webde_mailbox_subscription`: subscribe or unsubscribe an IMAP folder.
- `delete_webde_mailbox`: delete a user folder; protected system folder names are refused.

Website-only gaps:

IMAP/SMTP cannot manage every WEB.DE mail feature. Filters, aliases, sender identities, security
settings, and other browser-only mail settings need a signed-in browser automation path.
