import { observeOperation } from "./telemetry.ts";
import { YnabAccountIdSchema, YnabPlanIdSchema } from "./domain-schema.ts";
import type { SatispayTransactionId, YnabAccountId } from "./domain.ts";
import type { YnabAccounts } from "./ynab-contract.ts";
import { Effect, Redacted, Schema, Schedule } from "effect";
import { AppConfig, type YnabTarget } from "./application/app-config.ts";
import type { YnabImportResult, YnabServiceApi } from "./ynab-contract.ts";
export type { YnabEnv } from "./application/app-config.ts";
import {
  YnabError,
  YnabTransportError,
  YnabHttpError,
  YnabResponseError,
  YnabAccountError,
  YnabWriteDisabledError,
  YnabImportRejectedError,
  YnabImportUncertainError,
  YnabImportBatchError,
} from "./errors.ts";
export { YnabError } from "./errors.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { ImportCandidate, ImportPlan } from "./import-plan.ts";

// Preserve the existing envelope contract separately from operation-specific payloads.
const YnabEnvelopeSchema = Schema.Struct({
  data: Schema.Unknown.check(Schema.makeFilter((value) => Boolean(value))),
});

// Every response from YNAB is untrusted: decode the minimal API contract.
const AccountSchema = Schema.Struct({
  id: YnabAccountIdSchema,
  name: Schema.String,
  on_budget: Schema.Boolean,
  closed: Schema.Boolean,
  deleted: Schema.optionalKey(Schema.Boolean),
});
const PlansSchema = Schema.Struct({
  plans: Schema.Array(Schema.Struct({ id: YnabPlanIdSchema, name: Schema.String })),
});
const AccountsSchema = Schema.Struct({ accounts: Schema.Array(AccountSchema) });
const AccountResponseSchema = Schema.Struct({ account: AccountSchema });
const ImportResultSchema = Schema.Struct({
  transaction_ids: Schema.Array(Schema.String),
  duplicate_import_ids: Schema.Array(Schema.String),
});

// GET /plans returns the full list and has no page parameter. Account lookups
// stay capped so discovery cannot fan out without bound.
const MAX_DISCOVERED_PLANS = 20;

/** Preserve the original SHA-256 namespace and 36-character import IDs exactly. */
export function importIdEffect(satispayId: SatispayTransactionId) {
  return Effect.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("satispay-transaction-id-v1:" + satispayId),
      ),
    catch: () => new YnabError("Could not create stable import ID."),
  }).pipe(
    Effect.map(
      (hash) =>
        "SPS:" +
        [...new Uint8Array(hash)]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 32),
    ),
  );
}

export function buildYnabTransactionsEffect(
  candidates: ImportCandidate[],
  accountId: YnabAccountId,
) {
  return Effect.forEach(
    candidates,
    (row) =>
      Effect.map(importIdEffect(row.satispayId), (import_id) => ({
        account_id: accountId,
        date: row.date,
        amount: row.amountMilliunits,
        payee_name: row.payee,
        memo: row.memo || undefined,
        cleared: row.reviewReason ? ("uncleared" as const) : ("cleared" as const),
        approved: false,
        ...(row.reviewReason ? { flag_color: "orange" as const } : {}),
        import_id,
      })),
    { concurrency: 4 },
  );
}

/** Acquire infrastructure once; all returned operations are dependency-free. */
export const makeYnabClient = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const config = yield* AppConfig;
  const apiRequest = (path: string, token: Redacted.Redacted<string>, method: "GET" | "POST") => {
    const url = "https://api.ynab.com/v1" + path;
    return (method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.acceptJson,
    );
  };

  /** Request lifetime includes response decoding. Read/write policy stays at the caller. */
  function apiEffect(request: HttpClientRequest.HttpClientRequest) {
    return Effect.scoped(
      Effect.gen(function* () {
        const res = yield* http
          .execute(request)
          .pipe(Effect.mapError(() => new YnabTransportError({ reason: "Network" })));
        if (res.status < 200 || res.status >= 300)
          return yield* Effect.fail(
            new YnabHttpError({
              status: res.status,
              message: "YNAB API HTTP " + res.status + ". Check your plan, account and token.",
            }),
          );
        const { data } = yield* HttpClientResponse.schemaBodyJson(YnabEnvelopeSchema)(res).pipe(
          Effect.mapError(() => new YnabResponseError({ reason: "Json" })),
        );
        return data;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new YnabTransportError({ reason: "Timeout" })),
      }),
      observeOperation(request.method === "GET" ? "ynab.read" : "ynab.write"),
    );
  }

  const readApiEffect = (path: string, token: Redacted.Redacted<string>) =>
    apiEffect(apiRequest(path, token, "GET")).pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.exponential("200 millis"),
        while: (error) =>
          error._tag === "YnabTransportError" ||
          (error._tag === "YnabHttpError" && [502, 503, 504].includes(error.status)),
      }),
    );

  const postApiEffect = Effect.fnUntraced(function* (
    path: string,
    token: Redacted.Redacted<string>,
    body: unknown,
  ) {
    const request = yield* HttpClientRequest.bodyJson(apiRequest(path, token, "POST"), body).pipe(
      Effect.mapError(() => new YnabError("Cannot encode YNAB request")),
    );
    return yield* apiEffect(request).pipe(
      Effect.mapError((error) => {
        switch (error._tag) {
          case "YnabTransportError":
            return new YnabImportUncertainError({ reason: { _tag: error.reason } });
          case "YnabResponseError":
            return new YnabImportUncertainError({ reason: { _tag: "Json" } });
          case "YnabHttpError":
            return error.status >= 500
              ? new YnabImportUncertainError({ reason: { _tag: "Http", status: error.status } })
              : error;
        }
      }),
    );
  });

  const findSatispayAccountsEffect = Effect.fn("satispay.ynab.findAccounts")(function* () {
    const token = yield* config.token;
    const rawPlans = yield* readApiEffect("/plans", token);
    const { plans } = yield* Schema.decodeUnknownEffect(PlansSchema)(rawPlans).pipe(
      Effect.mapError(() => new YnabResponseError({ reason: "Plans" })),
    );
    const discoveredPlans = plans.slice(0, MAX_DISCOVERED_PLANS);
    const matches: Array<YnabAccounts["matches"][number]> = [];
    for (const plan of discoveredPlans) {
      const rawAccounts = yield* readApiEffect(
        "/plans/" + encodeURIComponent(plan.id) + "/accounts",
        token,
      );
      const { accounts } = yield* Schema.decodeUnknownEffect(AccountsSchema)(rawAccounts).pipe(
        Effect.mapError(() => new YnabResponseError({ reason: "Accounts" })),
      );
      for (const account of accounts) {
        if (
          account.name.toLowerCase().includes("satispay") &&
          !account.closed &&
          !account.deleted
        ) {
          matches.push({
            planId: plan.id,
            planName: plan.name,
            accountId: account.id,
            accountName: account.name,
            onBudget: account.on_budget,
          });
        }
      }
    }
    return { matches, truncated: plans.length > discoveredPlans.length };
  });

  const validateTargetAccountEffect = Effect.fn("satispay.ynab.validateAccount")(function* (
    target: YnabTarget,
  ) {
    const token = target.token;
    const rawAccount = yield* readApiEffect(
      "/plans/" +
        encodeURIComponent(target.planId) +
        "/accounts/" +
        encodeURIComponent(target.accountId),
      token,
    );
    const { account } = yield* Schema.decodeUnknownEffect(AccountResponseSchema)(rawAccount).pipe(
      Effect.mapError(
        () =>
          new YnabAccountError({
            reason: "Malformed",
          }),
      ),
    );
    const reason =
      account.id !== target.accountId
        ? "WrongId"
        : !account.name.toLowerCase().includes("satispay")
          ? "WrongName"
          : !account.on_budget
            ? "OffBudget"
            : account.closed
              ? "Closed"
              : account.deleted
                ? "Deleted"
                : undefined;
    if (reason) return yield* Effect.fail(new YnabAccountError({ reason }));
    return account;
  });

  const sendToYnabEffect = Effect.fn("satispay.ynab.importPlan")(function* (plan: ImportPlan) {
    if (!(yield* config.writesEnabled))
      return yield* Effect.fail(
        new YnabWriteDisabledError({
          message: "YNAB write disabled: set YNAB_WRITE_ENABLED=true",
        }),
      );
    if (plan.candidates.length > 10_000)
      return yield* Effect.fail(new YnabImportRejectedError({ reason: "BatchTooLarge" }));
    const target = yield* config.target;
    yield* validateTargetAccountEffect(target);
    let progress: YnabImportResult = {
      submitted: 0,
      processed: 0,
      duplicateImports: 0,
      ynabReportedTransactionIds: 0,
      confirmed: 0,
      uncertain: 0,
      failed: 0,
      notAttempted: plan.candidates.length,
    };
    const token = target.token;
    // Sequential batches: never retry a POST or continue after an uncertain write.
    for (let offset = 0; offset < plan.candidates.length; offset += 500) {
      const transactions = yield* buildYnabTransactionsEffect(
        plan.candidates.slice(offset, offset + 500),
        target.accountId,
      ).pipe(Effect.mapError((reason) => new YnabImportBatchError({ reason, progress })));
      const size = transactions.length;
      progress = {
        ...progress,
        submitted: progress.submitted + size,
        notAttempted: progress.notAttempted - size,
      };
      const data = yield* Effect.gen(function* () {
        const rawResult = yield* postApiEffect(
          "/plans/" + encodeURIComponent(target.planId) + "/transactions",
          token,
          { transactions },
        );
        const result = yield* Schema.decodeUnknownEffect(ImportResultSchema)(rawResult).pipe(
          Effect.mapError(() => new YnabImportUncertainError({ reason: { _tag: "Contract" } })),
        );
        if (result.duplicate_import_ids.length > size)
          return yield* Effect.fail(
            new YnabImportUncertainError({ reason: { _tag: "DuplicateCount" } }),
          );
        return result;
      }).pipe(
        Effect.mapError(
          (reason) =>
            new YnabImportBatchError({
              reason,
              progress: {
                ...progress,
                uncertain: reason._tag === "YnabImportUncertainError" ? size : 0,
                failed: reason._tag === "YnabImportUncertainError" ? 0 : size,
              },
            }),
        ),
      );
      const duplicates = data.duplicate_import_ids.length;
      progress = {
        ...progress,
        confirmed: progress.confirmed + size,
        processed: progress.processed + size - duplicates,
        duplicateImports: progress.duplicateImports + duplicates,
        ynabReportedTransactionIds:
          progress.ynabReportedTransactionIds + data.transaction_ids.length,
      };
    }
    return progress;
  });

  return {
    findAccounts: findSatispayAccountsEffect(),
    validateAccount: Effect.flatMap(config.target, validateTargetAccountEffect),
    importPlan: sendToYnabEffect,
  } satisfies YnabServiceApi;
});
