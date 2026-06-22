# WEB.DE Drafts

This plugin adds a local MCP server that creates draft emails in a WEB.DE mailbox and can send emails when you explicitly ask it to.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in your full `WEBDE_EMAIL` address and your application-specific `WEBDE_PASSWORD`.
3. Set `WEBDE_DRAFTS_MAILBOX` to the exact folder you want Codex to use for drafts.
4. Leave the server defaults unless you need a custom setup.

The server defaults to:

- IMAP host: `imap.web.de`
- IMAP port: `993`
- secure IMAP: `true`
- SMTP host: `smtp.web.de`
- SMTP port: `587`
- secure SMTP: `false` with STARTTLS

## What it does

The plugin only exposes narrow actions:

- verify access to the configured drafts folder
- save a draft there via IMAP `APPEND`
- send an email via SMTP
- attach real local files when sending

It does not expose tools for reading your inbox or browsing your mailbox contents.
