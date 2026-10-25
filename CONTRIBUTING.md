# Contributing

Thanks for your interest in Satispay → YNAB!

## Set up your fork

Follow the [Quick start](README.md#quick-start-from-fork-to-first-preview). Replace the tracked `wrangler.toml` with your own copy of `wrangler.example.toml`. Set `UPLOAD_TOKEN`, `YNAB_TOKEN`, `YNAB_PLAN_ID` and `YNAB_ACCOUNT_ID` as Cloudflare Worker Secrets (or in a Git-ignored `.dev.vars` for local development). Keep writes disabled until you review a dry run. Never put real YNAB account identifiers in tracked `[vars]`.

```bash
npm ci
npm run format:check
npm test
npm run check
npm run check:deps
npm run check:bundle
```

The bundle command runs Wrangler without deploying.

Run `npm run format` to format source files, tests and JSON configuration with Prettier.

## Development principles

- Keep money calculations deterministic and independent of Effect. Work with exact cents and YNAB milliunits.
- Handle I/O at Effect boundaries using typed errors, Schema and Context/Layer services.
- Use `ynabTestLayer` or an injected fake HTTP transport for tests. Never call production accounts from automated tests.
- Do not automatically retry an ambiguous YNAB transaction POST.
- Add regression tests for accounting changes, especially split funding, refunds, duplicate import IDs and cutoff dates.
- Preserve API response compatibility where possible and update the README when behavior changes.

## Security and privacy

Use synthetic transactions in bug reports and pull requests. Never share real financial exports, API credentials, session tokens or YNAB account identifiers. Report suspected security issues privately to the maintainer rather than posting sensitive details in public issues.
