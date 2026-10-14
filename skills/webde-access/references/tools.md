# Web.de Access Tool Behavior

Read-only tools:

- `check_webde_connection`: verifies IMAP, configured folders, and SMTP.
- `list_webde_mailboxes`: lists exact IMAP folder paths.
- `get_webde_mailbox_status`: returns count and UID metadata for one mailbox.
- `get_webde_quota`: returns IMAP quota data when WEB.DE exposes it.
- `search_webde_messages`: returns message summaries with UID, envelope, flags, size, and downloadable parts. `since`, `before`, and `on` take calendar dates in `YYYY-MM-DD` form; `uid` takes an IMAP UID set such as `40:50`.
- `read_webde_message`: parses a message into plain text, optional raw HTML, addresses, references, and attachment metadata. HTML-only messages still populate `parsed.text`; `parsed.textSource` reports whether text came from `text`, `html`, or `none`. `sourceTruncated: true` means the message is larger than the profile's `maxSourceMb`, so the body and attachment list may be incomplete.

Local export/download tools:

- `download_webde_attachment`: saves one IMAP body part (a part number such as `2` or `1.2` from the message's `attachments`) to the profile's `attachmentDownloadDir`. Parts larger than `maxAttachmentMb` fail instead of being saved cut off.
- `export_webde_message`: saves a complete raw `.eml` file to the profile's `attachmentDownloadDir`. Messages larger than `maxSourceMb` fail instead of being exported cut off.

Sending tools:

- `create_webde_draft`: appends a draft to the profile's drafts folder (`folders.drafts`) with optional local file attachments.
- `send_webde_email`: sends via SMTP and can append a sent copy to the profile's sent folder (`folders.sent`). If SMTP accepted the message but the copy could not be saved, the result is still a success and reports `sentCopy.error`; do not send the message again.
- `reply_webde_email`: infers reply recipients, sets threading headers when available, and quotes the original in the text and, when `html` is given, the HTML body.
- `forward_webde_email`: forwards message content (in the text and, when `html` is given, the HTML body) and can include original attachments. Messages larger than `maxSourceMb` cannot be forwarded with `includeOriginalAttachments`.

Message mutation tools:

- `mark_webde_messages`: read, unread, star, or unstar by UID.
- `move_webde_messages`: move UIDs to another mailbox.
- `copy_webde_messages`: copy UIDs to another mailbox.
- `delete_webde_messages`: move to trash by default, or permanently delete when explicit.

Mailbox mutation tools:

- `create_webde_mailbox`: create a user folder.
- `rename_webde_mailbox`: rename a user folder.
- `set_webde_mailbox_subscription`: subscribe or unsubscribe an IMAP folder.
- `delete_webde_mailbox`: delete a user folder; WEB.DE system folders and every folder mapped in the profile are refused.

Website-only gaps:

IMAP/SMTP cannot manage every WEB.DE mail feature. Filters, aliases, sender identities, security
settings, and other browser-only mail settings need a signed-in browser automation path.
