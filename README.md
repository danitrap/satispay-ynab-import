# Satispay → YNAB (inspect-only)

Cloudflare Worker for uploading an Excel **.xlsx** or CSV export from Satispay using the iOS Share Sheet and Apple Shortcuts.

**Safety:** this phase inspects file format, headers, row count and aggregate schema diagnostics (types/statuses, ID uniqueness and financial-field shapes). No individual transaction data is returned. No YNAB API calls or file storage are implemented.

## Deploy

Node.js >= 22. Cloudflare Workers builds from GitHub with an empty build command and deploy command `npx wrangler deploy`.

```sh
npm install
npm test
npm run check
npx wrangler secret put UPLOAD_TOKEN
npm run deploy
```

Create a random token (e.g. `openssl rand -hex 32`) and store it as `UPLOAD_TOKEN` in Cloudflare Workers Settings → Variables and Secrets. Never commit it. For local testing use `.dev.vars` (already gitignored).

## iPhone Shortcut configuration

1. In **Shortcuts**, create "Import Satispay" and enable **Show in Share Sheet**; accept files.
2. Add **Get Contents of URL** with `https://satispay-ynab-import.daniele-trapani.workers.dev/inspect`.
3. Method: `POST`; header `Authorization`: `Bearer YOUR_UPLOAD_TOKEN`.
4. **Request Body → File → Shortcut Input**. Do not choose JSON or Form. Do not manually set `multipart/form-data`.
5. Add **Show Result** (or extract `rowCount`, `columns`, `format` and `message` from the JSON).
6. Export Excel from Satispay and share the .xlsx into your Shortcut. If necessary, save it to Files first and share it from there.

The Worker now accepts raw request bodies (ideal for Shortcuts) and still supports multipart/form-data where the file field is called `file`. It detects XLSX by the ZIP signature, so a filename is not needed for raw uploads. Old binary `.xls` files are not supported.

## API

`GET /health`: returns `ok`, `mode: "inspect-only"`, `formats: ["xlsx","csv"]`, `upload: ["raw","multipart"]`.

`POST /inspect`: bearer token required, binary file in request body or multipart field `file`. Response contains `columns`, `rowCount`, `format`, `analysis` and `imported: 0`. Analysis only contains counts and categorical values, never individual names, descriptions, amounts, IDs or ledger balances. File content is held in memory and discarded. Maximum file size 4 MB, maximum request size 4.5 MB.

Example with CSV (same upload mechanism as Excel):

```sh
curl -X POST 'https://satispay-ynab-import.daniele-trapani.workers.dev/inspect' \
  -H 'Authorization: Bearer YOUR_UPLOAD_TOKEN' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @samples/fake-export.csv
```

For XLSX set Content-Type to `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (or leave it as octet-stream).

## Next

Inspect an actual Satispay export to identify columns, dates, amounts, account transfers and stable transaction IDs. Then add YNAB mapping, a D1 deduplication ledger, explicit preview and safe idempotent imports. A transfer from Revolut to Satispay must not become a duplicated expense.

Never upload raw financial exports, credentials, or access tokens to the GitHub repository.
