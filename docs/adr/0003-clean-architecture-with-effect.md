# Clean architecture, with Effect services as ports

We are restructuring the importer into clean-architecture layers so movement classification, matching merchant refunds to original purchases, and the wallet balance check can be tested without the Worker runtime or the YNAB API, and so integrations can be swapped later. The layers are `src/domain/` (pure functions and types, no Effect and no exceptions), `src/application/` (use cases and the ports they need), `src/infrastructure/` (the Satispay export reader, the YNAB gateway and Cloudflare bindings), `src/http/` (controllers and presenters) and `src/main.ts` as the only composition root. Ports are Effect services (`Context.Service`) and implementations are `Layer`s, rather than hand-rolled interfaces or per-use-case input and output boundaries, because Effect is already the project's backbone and its services already provide that seam.

## Consequences

- The domain never sees the Satispay export format: an infrastructure reader turns a Satispay export into Satispay movements, so column names and status labels live in one place.
- Preview and prepared import share one movement classification. Preview does not apply the import cutoff.
- The YNAB gateway lists accounts, reads one account and creates one import batch of YNAB transactions. The write gate, the limit of 10,000 import candidates, sequential batches of 500, target-account rules, the ADR 0001 representation of provisional transactions (orange flag, explanatory memo, uncleared and unapproved) and import outcome counting all move into the import use case.
- Import identity (`SPS:` prefix and SHA-256) is computed when translating a Satispay movement into a YNAB transaction, and a golden test pins it, because changing it would create duplicates in YNAB.
- Use cases return neutral results, including a prepared import and an import outcome. Presenters in `src/http/` own the JSON shape, the response mode and the error-to-status mapping.
- CSV inspection is removed.
- A dependency-cruiser check forbids `src/domain/` from importing any other layer, without introducing ESLint for this rule.
- The migration is progressive: one pull request at a time, CI always green, with the end-to-end fixture tests as the safety net. There is no big-bang rewrite branch.
