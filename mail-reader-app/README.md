# OrderBridge

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
MAIL_SYNC_LIMIT=50
MAIL_SYNC_DAYS=3650
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

IMAP mode reads `INBOX` by default, fetches and retains up to 50 recent mails, stores normalized messages in `mail-reader-app/data/imported-mails.json`, and keeps sync state there. It uses `messageId` first and `uid` as a fallback to avoid importing the same mail twice. Logs report scanned, added, and skipped counts.

## Order Recognition Storage

When `POST /api/mail/:emailId/generate-order-draft` succeeds, the recognized order is saved to the local SQLite file `data/order-recognition.db`. It stores the order's key requirements and its recognized model, quantity, unit, and confidence values. Re-generating the same email replaces its previous items rather than creating duplicates.

For speed, complete high-confidence spreadsheet/table rows are converted locally without an LLM call. Ambiguous body text, images, PDFs, and incomplete tables continue through the configured DeepSeek model. `LLM_TIMEOUT_MS` limits remote model waits and defaults to 120 seconds. DeepSeek requests explicitly disable thinking mode by default for low-latency order parsing; set `LLM_THINKING_ENABLED=true` when deeper reasoning is preferred over response speed.

Set `ORDER_DRAFT_CACHE_ENABLED=false` during benchmarking so every request runs independently. When set to `true`, successful responses are cached in memory by mail content and model configuration (up to 100 entries), and concurrent requests for the same mail share one generation.

Matching services can read the intermediate records through:

- `GET /api/order-recognitions`
- `GET /api/order-recognitions/:id`

Each item exposes both `model_raw` and `model_normalized`; matching logic should use the latter as its stable input while retaining the former for display and review.

## Product Matching

Product matching compares `recognition_order_items.model_normalized` with
`test_product_catalog.normalized_code`. Exact matches are auto-confirmed.
Non-exact models use partial-ratio Top-3 matching plus specification conflict
checks and remain pending for manual review. Weak candidates are recorded as
`no_match` rather than being forced to a product.

- `POST /api/order-recognitions/:id/product-matches` reruns and saves matches.
- `GET /api/order-recognitions/:id/product-matches` returns saved results and candidates.

Newly generated order drafts are matched automatically after their recognition
items are saved. The current `test_product_catalog` is derived from historical
recognition data for integration testing and must not be treated as the official
business product master.

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
