# Agent guide

- Write all repository documentation in English.

- Read `CONTRIBUTING.md` before changing code for development principles, validation commands, and privacy requirements.
- For Effect APIs, implementation details, or usage patterns, consult the pinned sources in `vendor/effect/`. If missing, run `vendor install --frozen`; see the README's “Local Effect source reference” section for CLI setup.
- Keep money calculations in the pure domain modules and asynchronous I/O at Effect service boundaries. Use `requestLiveLayer` as the request composition root.
- When changing accounting or import behavior, add regression coverage using synthetic transactions and injected services. Preserve the single-attempt policy for YNAB transaction POSTs and the explicit handling of uncertain writes.
