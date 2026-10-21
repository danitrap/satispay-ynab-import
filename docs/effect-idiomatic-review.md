# Effect pattern review

This review compares the application with the local Effect 4.0.5 sources at
commit `7f524e25cfb49a71ac39b0f44278d08d40dda5de` (see `vendors.lock`).
All five improvements below have been implemented. Envelope validation remains
separate from payload validation to preserve public failure reasons and retry
boundaries.

## 1. Expose Effect in the WorkbookReader contract

`WorkbookReader.read` in `src/workbook-reader.ts` now returns
`Effect.Effect<SheetCell[][], WorkbookError>`. The live adapter owns
`Effect.tryPromise` and classifies expected decoding failures; consumers compose
the operation directly. Test implementations can return `Effect.succeed`,
`Effect.fail`, or `Effect.die`. `WorkbookError` lives in `src/errors.ts` to avoid
a runtime dependency cycle between the decoder and workbook analysis.

Promises remain appropriate inside the external library adapter. This refactor
does not make a library cancellable unless it supports AbortSignal.

Sources: `vendor/effect/LLMS.md:122` and
`vendor/effect/ai-docs/src/50_http-client/10_basics.ts` show services exposing
Effect operations with declared errors.

## 2. Use the native duration combinator

`src/telemetry.ts` now uses `Effect.trackDuration` instead of subtracting Unix
timestamps from `Clock.currentTimeNanos`. The native combinator uses a monotonic
clock and updates the metric in `onExit`, including failures and interruptions.
The existing histogram and millisecond unit are preserved:

```ts
Effect.trackDuration(
  Metric.withAttributes(operationDuration, { operation }),
  Duration.toMillis,
)
```

The outcome counter still uses Exit. Replacing it with only
`trackSuccesses`/`trackErrors` would change coverage of defects and interruptions.
Tests cover all four outcomes and a wall clock moving backward, with an isolated
metric registry.

Sources: `vendor/effect/packages/effect/src/Effect.ts:14731`,
`vendor/effect/packages/effect/src/Clock.ts:311`, and
`vendor/effect/packages/effect/src/Clock.ts:333`.

## 3. Validate the YNAB response envelope with Schema

`src/ynab.ts` now uses `HttpClientResponse.schemaBodyJson` with an envelope Schema
to read JSON and validate `data`, replacing manual envelope checks. Callers then
decode operation-specific payloads with their existing Schemas.

The separate stages preserve distinctions between invalid JSON or envelopes,
invalid payloads, malformed target accounts, and uncertain POST outcomes.
Schema failures remain outside the retryable network failure category. Response
body reading and envelope decoding stay within the HTTP scope and deadline.

Sources: `vendor/effect/packages/effect/src/http/HttpIncomingMessage.ts:80` and
`vendor/effect/ai-docs/src/50_http-client/10_basics.ts`.

## 4. Keep tokens Redacted until the authentication helper

Internal YNAB request helpers now accept `Redacted.Redacted<string>` and pass it
to `HttpClientRequest.bearerToken`, avoiding repeated early extraction and manual
Authorization header construction. The HTTP header still contains the token:
this simplifies value handling without adding transport or logging guarantees.

Source: `vendor/effect/packages/effect/src/http/HttpClientRequest.ts:432`.

## 5. Standardize reusable generator functions

`handleRequestEffect` in `src/index.ts` and `postApiEffect` in `src/ynab.ts` now
use `Effect.fnUntraced`. Use `Effect.fn` when a tracing span is useful and
`Effect.fnUntraced` for internal helpers. `makeYnabClient` remains an Effect value
because it is a service construction program.

Sources: `vendor/effect/LLMS.md:13` and `vendor/effect/LLMS.md:51`.

## Architectural choices to preserve

- Pure financial domain logic, branded units, and exact conversions.
- `requestLiveLayer` as the request composition root with lazy configuration.
- YNAB contracts independent of implementation dependencies.
- HTTP scopes covering response body reading, bounded GET retries, and single-attempt POSTs.
- Typed failures distinct from unexpected defects, with sensitive details excluded from responses.
- Synthetic tests using injected services and TestClock.

Upload cleanup in `src/index.ts` has a concrete purpose: with
`releaseLockOnEnd: true`, the reader finalizer releases its lock while the outer
finalizer cancels the body. Preserve both responsibilities when refactoring.
Source: `vendor/effect/packages/effect/src/Channel.ts:1891`.

HttpRouter/HttpApi and @effect/vitest are options as the API and test suite grow;
they alone do not justify migrating the current router and test runner.

## Validation

`npm run check`, `npm test`, `npm run format:check`, and dry-run bundling passed:
valid TypeScript, 83 passing tests, correct formatting, and a successful bundle.
For bundling, `XDG_CONFIG_HOME` and `WRANGLER_LOG_PATH` point to `/tmp` to respect
the sandbox.

New regressions cover a wall clock moving backward, all telemetry outcomes,
injected decoder failures and defects, and malformed YNAB responses without
retries. No live imports were performed.
