# Agent guide

- Write all repository documentation in English.

- Read `CONTRIBUTING.md` before changing code for development principles, validation commands, and privacy requirements.
- For Effect APIs, implementation details, or usage patterns, consult the pinned sources in `vendor/effect/`. If missing, run `vendor install --frozen`; see the README's “Local Effect source reference” section for CLI setup.
- Keep money calculations in the pure domain modules and asynchronous I/O at Effect service boundaries. Use `requestLiveLayer` in `src/main.ts` as the request composition root.
- When changing accounting or import behavior, add regression coverage using synthetic transactions and injected services. Preserve the single-attempt policy for YNAB transaction POSTs and the explicit handling of uncertain writes.

## Layers

The importer is four layers plus one composition root, as recorded in ADR 0003. `npm run check:deps` enforces the dependency rule for every module under `src/`: a domain module imports other domain modules, the application imports the domain and its own ports, infrastructure and HTTP each import only the domain, the application, and their own layer, and modules under `src/` do not form a cycle. Branded primitives use Effect's `Brand` as a type; the domain does not run Effect. `src/main.ts` is the only module outside the four layers.

| Layer | Put new code here when |
| --- | --- |
| `src/domain/` | It is a pure movement rule: classification, merchant-refund matching, wallet amounts, the wallet balance check, or a prepared import. No Effect runtime, no exceptions, no I/O. |
| `src/application/` | It is a use case or a port. Ports are Effect services: `AppConfig`, `AuthRateLimit`, `WorkbookReader`, `SatispayExportReader`, `SheetAnalysis`, `YnabGateway`, and `YnabPlanCatalog`. |
| `src/infrastructure/` | It talks to Satispay exports, YNAB, or Cloudflare. Column names and status labels stay in the Satispay export reader. Implement a port with a `Layer`. A use case calls the port; `requestLiveLayer` supplies the Layer. |
| `src/http/` | It authorizes a request, bounds an upload, or shapes a response. Controllers parse the request, call a use case, and hand the result to a presenter. Presenters own the JSON shape, the response mode, and the error-to-status mapping. |
| `src/main.ts` | It wires a port to its Layer inside `requestLiveLayer`. Use cases and business rules stay in their layers. |

A new module belongs in one of the four layers. `src/main.ts` is the only source file that stays beside them.

## Test seams

Exercise behavior through a seam. Use synthetic movements only.

1. **Worker fetch handler** (`handleRequestEffect`) with a fake YNAB fetch and the synthetic xlsx fixtures. This is the safety net for unchanged import behavior, including import identity.
2. **Import use case** (`importPrepared`) against a fake YNAB gateway Layer. This covers the write gate, the 10,000-candidate limit, batches of 500, target-account rules, provisional transactions, and import outcome counting.

The golden import-identity test pins `SPS:` and SHA-256. Do not change that algorithm.

## Agent skills

### Issue tracker

Track issues and specs in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context glossary and ADR layout. See `docs/agents/domain.md`.
