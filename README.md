# Satispay → YNAB

**Import Satispay transactions into YNAB. Self-hosted, reviewable, and built with Cloudflare Workers + Effect v4.**

[![TypeScript 7](https://img.shields.io/badge/TypeScript-7.0.2-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Effect 4](https://img.shields.io/badge/Effect-4.0.5-6750A4)](https://effect.website/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![Apache License 2.0](https://img.shields.io/badge/License-Apache%202.0-D22128?logo=apache&logoColor=white)](LICENSE)

Turn a manually exported Satispay Excel workbook into YNAB transactions using a small HTTP API. Inspect an export, preview the impact on your budget, and explicitly confirm an import. Use it from [Apple Shortcuts](https://support.apple.com/guide/shortcuts/welcome/ios), a terminal, or any HTTP client.

No scraping, scheduled access to your Satispay account, database, or continuously running server.

> [!IMPORTANT]
> This is an **unofficial, community-maintained integration** and is not affiliated with Satispay or YNAB. You must export your transactions yourself. Always review imported transactions in YNAB.

## Highlights

- **Wallet-first accounting:** import the cash portion of a movement, regardless of its Satispay transaction type.
- **Benefit-aware:** exclude meal-voucher and other benefit balances from your cash-wallet account.
- **Mixed-refund handling:** match merchant refunds against their original purchases and avoid overstating the cash portion.
- **Safe previews:** inspect file structure, summarize all movements, or simulate your next import before writing anything.
- **Deterministic deduplication:** derive YNAB import IDs from stable Satispay transaction identifiers.
- **Balance diagnostics:** compare movements with the export's available balance snapshots.
- **Composable architecture:** Effect v4, typed failures, Schema validation, and Context/Layer-based HTTP services.
- **Deploy anywhere Workers runs:** a single Cloudflare Worker, without an application database.

## How it works

~~~text
Satispay .xlsx export
        │
        ▼
 Apple Shortcut / curl
        │
        ▼
  Cloudflare Worker ─────────────────────────────┐
        │                                        │
    Parse workbook                               │
        │                                        │
    Validate rows                                │
        │                                        │
    Resolve mixed refunds                        │
        │                                        │
    Build import plan                            │
        │                                        │
        ├── /preview ──► Read-only summary       │
        ├── /prepare ──► Cutoff-aware dry run    │
        │                                        │
        └── /import ──► YNAB API                 │
                          │                      │
                     Deduplicate & match         │
                          │                      │
                     Review in YNAB ◄────────────┘
~~~

Uploads are processed in memory. The Worker does not store transaction exports, and YNAB handles deduplication for previously imported IDs.

## Quick start: from fork to first preview

### Requirements

- Node.js **22+** and npm
- A [Cloudflare account](https://dash.cloudflare.com/)
- A [YNAB API personal access token](https://api.ynab.com/)
- A Satispay **Excel (`.xlsx`)** transaction export
- An active, **on-budget** YNAB account whose name contains **Satispay**

### 1. Fork and install

Fork this repository on GitHub, then clone **your fork**:

~~~bash
git clone https://github.com/<your-user>/satispay-ynab-import.git
cd satispay-ynab-import
npm ci
~~~

### 2. Set up your own Worker

Copy the sanitized configuration example:

~~~bash
cp wrangler.example.toml wrangler.toml
~~~

Update `wrangler.toml` for **your** installation:

~~~toml
name = "my-satispay-ynab-import"

[vars]
YNAB_WRITE_ENABLED = "false"
YNAB_IMPORT_FROM = "2026-01-01"
~~~

Store `YNAB_PLAN_ID` and `YNAB_ACCOUNT_ID` **as Worker Secrets**, alongside the two access tokens. None of the four belongs in versioned `[vars]` configuration.

The date is only an example: set `YNAB_IMPORT_FROM` to the **first date you intend to import** (inclusive). Avoid importing history that is already reconciled in YNAB. Leave writes disabled until you've checked a dry run.

> [!WARNING]
> A fork inherits the tracked `wrangler.toml`, including a Worker name and an import cutoff. **Replace it with your own copy of the example before deploying**, and choose a unique Worker `name`. The four Secrets must be configured separately for each deployment.

| Variable | What it does |
| --- | --- |
| `YNAB_PLAN_ID` | **Secret** — YNAB plan (budget) ID |
| `YNAB_ACCOUNT_ID` | **Secret** — destination Satispay account ID |
| `YNAB_IMPORT_FROM` | **`[vars]`** — inclusive `YYYY-MM-DD` import cutoff |
| `YNAB_WRITE_ENABLED` | **`[vars]`** — explicit write switch; start with `false` |
| `UPLOAD_TOKEN` | **Secret** — authorizes access to the Worker |
| `YNAB_TOKEN` | **Secret** — YNAB personal access token |

For local testing, copy the secrets template and fill in your own values:

~~~bash
cp .dev.vars.example .dev.vars
npm run dev
~~~

The `.dev.vars` file is ignored by Git and must contain all four Secrets for local import tests. For a deployed Worker, set the Secrets through Cloudflare Settings → Variables and Secrets or with:

~~~bash
npx wrangler secret put UPLOAD_TOKEN
npx wrangler secret put YNAB_TOKEN
npx wrangler secret put YNAB_PLAN_ID
npx wrangler secret put YNAB_ACCOUNT_ID
~~~

`UPLOAD_TOKEN` should be an independently generated, long random string, **not** your YNAB token.

### 3. Find your YNAB account IDs

Start the Worker locally with `npm run dev`, or deploy it with `npm run deploy`. Once `YNAB_TOKEN` and `UPLOAD_TOKEN` are configured, use:

~~~bash
curl -H "Authorization: Bearer <your-upload-token>" \
  "http://localhost:8787/ynab/accounts"
~~~

The endpoint returns accessible, active YNAB accounts containing "Satispay" in their name, including their plan and account IDs. Use those IDs to set the `YNAB_PLAN_ID` and `YNAB_ACCOUNT_ID` Secrets on the deployed Worker (and in your ignored local `.dev.vars`); do **not** add the IDs to `wrangler.toml`.

To deploy:

~~~bash
npm run deploy
~~~

For Cloudflare Git-connected deployments, use **`npx wrangler deploy`** as the deploy command. Wrangler handles the TypeScript bundle; there is no separate build output directory to configure. Wrangler preserves existing Worker Secrets on normal deployments, even when those Secret names are absent from `wrangler.toml`. The non-secret `[vars]` values are still controlled by the file.

### 4. Preview an export

Use your local URL (`http://localhost:8787`) or a deployed Worker:

~~~bash
export WORKER_URL="https://<your-worker>.workers.dev"
export UPLOAD_TOKEN="<your-upload-token>"

curl --fail-with-body "$WORKER_URL/preview" \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@export.xlsx"
~~~

`/preview` analyzes the **whole workbook** without the import cutoff. Look for `eligible`, `requiresReview`, `refundsAdjusted` and `balanceCheck`.

Then preview **exactly which transactions are in scope for import**:

~~~bash
curl --fail-with-body "$WORKER_URL/prepare" \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@export.xlsx"
~~~

`/prepare` is read-only and applies `YNAB_IMPORT_FROM`.

### 5. Enable imports

When your dry-run looks correct, set `YNAB_WRITE_ENABLED = "true"` in `wrangler.toml` and redeploy. Imports still require the additional confirmation header:

~~~bash
curl --fail-with-body "$WORKER_URL/import" \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "X-Confirm-Import: yes" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@export.xlsx"
~~~

Check the response and **review, categorize, approve and reconcile** the transactions in YNAB.

> [!CAUTION]
> This importer deliberately creates **ordinary inflows and outflows**, not YNAB transfers. Reclassify wallet top-ups and movements between your own accounts as transfers in YNAB to avoid double-counting income or expenses.

## Apple Shortcuts

You can run the same workflow from an iPhone, without opening a terminal.

Create a Shortcut that **accepts files from the Share Sheet** and uses **Get Contents of URL**:

| Setting | Value |
| --- | --- |
| URL | `https://<your-worker>.workers.dev/import` |
| Method | `POST` |
| `Authorization` header | `Bearer <your-upload-token>` |
| `X-Confirm-Import` header | `yes` |
| Request body | **File → Shortcut Input** |

Don't select JSON or Form as the request body, and don't manually set a multipart boundary.

Read the JSON response with **Get Dictionary Value**: if `ok` is true, show `processed` and `duplicateImports`; otherwise, display `error`. Optionally open the YNAB app afterwards.

**Treat the Shortcut as a secret** if it includes `UPLOAD_TOKEN`. Do not publish a copy with your token embedded.

## API reference

All responses are JSON. Every endpoint except `GET /health` requires `Authorization: Bearer <UPLOAD_TOKEN>`.

| Method | Route | Description | YNAB write? |
| --- | --- | --- | --- |
| GET | `/health` | Health and supported capabilities | No |
| GET | `/ynab/accounts` | Discover accessible Satispay-named YNAB accounts | No |
| POST | `/inspect` | Inspect workbook or CSV columns and aggregate statistics | No |
| POST | `/preview` | Analyze all wallet movements; ignore the import cutoff | No |
| POST | `/prepare` | Build a cutoff-aware import plan | No |
| POST | `/import` | Submit valid movements to YNAB | **Yes** |

`/inspect` accepts `.xlsx` and CSV. The other upload endpoints accept `.xlsx` only. Upload a raw file body (recommended) or a multipart file in the field `file`.

**Limits:** 4 MB per file, 4.5 MB per request, and at most **100 import candidates per batch**. Old binary `.xls` files are not supported.

`/import` also requires `X-Confirm-Import: yes` and `YNAB_WRITE_ENABLED = "true"`. It checks that the destination account is active, on-budget, and named Satispay before writing.

Configuration is validated only when an operation needs it. `/health` needs no credentials; `/inspect` and `/preview` need only `UPLOAD_TOKEN`; `/prepare` also needs a real calendar date in `YNAB_IMPORT_FROM`. Account discovery needs `YNAB_TOKEN`, and imports additionally need target plan/account IDs and an enabled write switch. An absent write switch defaults to disabled; its accepted values are exactly `"true"` and `"false"`.

Authenticated configuration failures return HTTP **409**, disabled writes return **403**, and invalid workbooks, blocked movements or unsuitable destination accounts return **422**. YNAB transport/response failures return **502**. Import failures retain their existing `mode`, summary and `error` fields. If the POST outcome is uncertain, the error asks you to verify the import in YNAB before repeating it.

### Reading the result

~~~json
{
  "ok": true,
  "mode": "import-completed",
  "eligible": 2,
  "submitted": 2,
  "processed": 1,
  "duplicateImports": 1,
  "ynabReportedTransactionIds": 1
}
~~~

*Illustrative response; your results will vary.*

| Field | Meaning |
| --- | --- |
| `eligible` | Valid, cutoff-eligible movements selected from the workbook |
| `submitted` | Number of transactions sent to YNAB |
| `duplicateImports` | Import IDs YNAB reports as already imported |
| `processed` | Submitted minus duplicates; **may include transactions matched to existing YNAB entries** |
| `imported` | Backward-compatible alias for `processed`, **not** a count of newly created YNAB rows |
| `ynabReportedTransactionIds` | Number of YNAB transaction IDs returned; can exceed `submitted` due to matching |
| `rejected` / `issues` | Invalid or unresolved movements blocking a write |
| `refundsAdjusted` | Refunds corrected to reflect the original wallet-funded amount |
| `refundsUnresolved` | Refunds that could not be matched safely |
| `balanceCheck` | Balance reconciliation diagnostics (`ok`, `mismatch`, or `unavailable`) |
| `inflowMilliunits` / `outflowMilliunits` / `netMilliunits` | Aggregate amounts in YNAB milliunits (EUR 1 = 1,000 milliunits) |

The YNAB API does not reliably distinguish **newly created** transactions from **matched** ones using the `processed` count alone.

## Accounting rules

The importer tracks **cash wallet availability**, using the Italian `Disponibilità` column in the Satispay export.

| Export data | YNAB behavior |
| --- | --- |
| Negative `Disponibilità` | Regular outflow, whatever the transaction type |
| Positive `Disponibilità` | Regular inflow, whatever the transaction type |
| Empty or zero `Disponibilità` | Skipped |
| Purchase split between wallet and vouchers/benefits | Wallet-funded portion only |
| Voucher-only or benefit-only movement | Skipped |
| Unknown transaction type with a valid wallet movement | Included |
| Cashback/points credited to wallet | Regular inflow, using a recognizable payee |

Movement types do **not** determine whether a transaction is included or considered a transfer. If `Nome` (payee) is absent or `-`, a descriptive `Satispay — <type>` fallback is used.

The importer enforces valid dates, approved status (`✅ Approvato`), unique **textual** Satispay IDs and cent-exact wallet amounts. Invalid in-scope rows prevent the batch from being written.

### Mixed-funding refunds

Some Satispay exports display the **entire refunded purchase value** in the wallet availability field, even when part of that purchase originally used meal vouchers or other benefits.

For a `🔄 Rimborso` row, the importer looks for **exactly one** original `🏬 a un Negozio` purchase with:

- The same merchant name (case- and whitespace-normalized)
- The opposite total amount
- An approved status
- A preceding date, no more than **90 days** before the refund
- A consistent allocation between wallet availability and benefit columns

If the match is unambiguous, only the originally wallet-funded amount is imported as a refund. Otherwise, the refund is flagged for review instead of guessing.

**Keep enough history in your export to include original purchases for any refunds.** Re-importing overlapping historical periods is supported through deterministic import IDs and the configured date cutoff.

### Balance checks

`/preview` and `/prepare` report `balanceCheck`. When suitable snapshots exist, it compares the delta between the oldest and newest available balances with the sum of wallet movements **between** those snapshots. The reported delta may therefore differ from `netMilliunits` across the entire export, because the oldest snapshot already includes its transaction.

Balance discrepancies are **diagnostic**, not automatically a reason to block all imports. Invalid or unresolved candidate transactions do block writes.

## Architecture

The code separates **pure financial calculations** from **effectful I/O**.

~~~text
src/
├── config.ts          Request-scoped, lazily validated Cloudflare bindings
├── domain.ts          Pure constructors for dates, identifiers and exact money units
├── domain-schema.ts   Schema validation for branded boundary values
├── errors.ts          Tagged application failures and import diagnostics
├── failure-message.ts Safe presentation of structured failure reasons
├── index.ts           Worker routes, authorization, bounded uploads
├── spreadsheet.ts     XLSX decoding and workbook inspection
├── csv.ts             CSV inspection
├── ledger.ts          Pure refund resolution and balance auditing
├── preview.ts         Pure whole-export classification and summaries
├── import-plan.ts     Pure cutoff-aware import planning
├── import-handler.ts  Decode → plan → optionally import
├── ynab-service.ts    Effect Context.Service and Layer composition
├── ynab-contract.ts   Explicit, infrastructure-free YNAB operation contracts
└── ynab.ts            Effect HttpClient, Schema validation, YNAB API
~~~

The Worker uses [Effect v4](https://effect.website/) throughout its asynchronous boundaries:

- **`Effect.gen`** composes file decoding, validation and remote API calls with typed errors.
- **`Context.Service`** declares the `YnabService` required by import and account-discovery operations.
- **`Config` + `Schema`** validate operation-specific settings from Cloudflare bindings; `Redacted` keeps decoded tokens out of ordinary diagnostic output. Configuration failures retain only the setting name and a safe message.
- **`Layer`** provides the HTTP-backed implementation at the Worker request boundary. `ynabTestLayer` replaces it with an in-memory service in tests.
- **Effect `HttpClient` + `FetchHttpClient`** run YNAB API requests using a fetch-compatible transport suitable for Cloudflare Workers.
- **`Schema.decodeUnknownEffect`** validates incoming YNAB JSON instead of trusting untyped responses.
- **`Effect.forEach`** produces stable SHA-256 import IDs with bounded concurrency.
- **`Data.TaggedError` + `Effect.catchTags`** distinguish configuration, validation, transport and uncertain import failures. The import pipeline returns tagged application outcomes; the router owns HTTP status codes and JSON responses.

The domain modules stay independent of Effect. There is no global runtime holding Cloudflare request credentials; the live service Layer is provided per request.

`requestLiveLayer` is the single composition root for each request. It provides one configuration module and the fetch transport, then builds the YNAB implementation, which closes over those dependencies. The router and import programs consume their declared requirements; `YnabServiceApi` describes public results and failures independently of the implementation. Type-level tests verify that public operations leave no infrastructure requirements for callers.

Money units and identifiers have distinct branded types. Pure constructors check exact cents and safe milliunit conversions; unsafe movements are flagged for review, overflowing totals are rejected, and balance audits report unavailable when their arithmetic cannot remain exact. Schema validates calendar dates and target IDs at the request boundary. Failures carry structured reasons with safe, derived messages; only known plan-input errors are treated as invalid uploads, while unexpected planning exceptions remain defects.

**No automatic retries of YNAB POST imports.** A response can be lost after YNAB accepts a request, so ambiguous results must be checked before retrying.

## Development

Use `npm ci` to install the exact dependency versions recorded in `package-lock.json` (Node.js 22+).

~~~bash
npm ci
npm test                # Test suite
npm run check           # TypeScript type check
npm run check:bundle    # Wrangler dry-run bundle (no deployment)
npm run dev             # Local Worker
~~~

The tests use Node's built-in test runner. They cover wallet-only funding, mixed refunds, duplicate IDs, eligibility filters, YNAB result handling, HTTP failures, and Effect service Layers.

GitHub Actions runs the test suite, TypeScript checks, and Wrangler bundle checks on pull requests and pushes to `main`.

### Cloudflare Preview environments

The example Wrangler configuration includes a separate `[previews.vars]` block, with YNAB writes **disabled** and placeholder account IDs. These are deliberately fake Preview values, not production IDs. Cloudflare's `wrangler preview` expects its preview configuration to be explicit.

Test `GET /health` without credentials. For authenticated endpoints, configure a **separate preview-only `UPLOAD_TOKEN`**. Do not copy production YNAB credentials into an untrusted Preview environment.

## Security and limitations

- Satispay exports are uploaded **on demand**. This project does not log into, scrape, or continuously synchronize a Satispay account.
- Authentication is required on all non-health endpoints. Keep both tokens secret, rotate them if exposed, and never commit a real export.
- The account must be active, on-budget and contain "Satispay" in its name.
- Sensitive transaction details are not included in aggregate API responses.
- Exports are parsed in memory, with strict request-size limits.
- YNAB categories, real transfers, approval and reconciliation remain manual.
- A refund whose original purchase is missing or ambiguous requires review; try a broader export.
- Imported transactions are sent as cleared and unapproved (`cleared: "cleared"`, `approved: false`).
- If the Worker reports an uncertain YNAB response, inspect YNAB before resubmitting.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, financial-correctness requirements, and privacy guidelines. Use only synthetic exports and credentials in issues or pull requests.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [LICENSE](LICENSE) for the full terms.

---

Built with [Effect](https://effect.website/), [Cloudflare Workers](https://developers.cloudflare.com/workers/), and the [YNAB API](https://api.ynab.com/). Satispay and YNAB are trademarks of their respective owners.
