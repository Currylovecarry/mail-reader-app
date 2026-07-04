# Mail Reader App

This app can run in two mailbox modes:

- `MAIL_MODE=agent`: keep the original Agent Mail flow through `agently-cli`.
- `MAIL_MODE=imap_smtp`: sync a normal mailbox over IMAP and send mail over SMTP.

## Configure IMAP/SMTP

Copy `.env.example` to `.env` in this directory and fill in the mailbox provider settings:

```env
MAIL_MODE=imap_smtp
MAIL_EMAIL=your_email@example.com
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_MAILBOX=INBOX
MAIL_SYNC_LIMIT=30
MAIL_SYNC_DAYS=30
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
MAIL_AUTH_CODE=your_authorization_code_or_app_password
```

`MAIL_AUTH_CODE` must be the provider-generated authorization code or app password, not the normal mailbox login password. Do not commit `.env`.

## Run

```bash
node mail-reader-app/server.mjs
```

Open `http://127.0.0.1:3080` and click the import button to sync mail.

You can also generate the static `mail-data.js` snapshot:

```bash
node mail-reader-app/import-mails.mjs
```

## Sync Behavior

IMAP mode reads `INBOX` by default, fetches up to 30 recent mails, stores normalized messages in `mail-reader-app/data/imported-mails.json`, and keeps sync state there. It uses `messageId` first and `uid` as a fallback to avoid importing the same mail twice. Logs report scanned, added, and skipped counts.

## Send Mail

The backend exposes `POST /api/mail/send` with JSON:

```json
{
  "to": "customer@example.com",
  "subject": "Reply subject",
  "text": "Mail body"
}
```

SMTP uses `MAIL_EMAIL` as the sender and `MAIL_AUTH_CODE` for login. The authorization code is never returned to the frontend or printed in logs.
