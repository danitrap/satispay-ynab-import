import { observeOperation } from "./telemetry.ts";
import { YnabAccountIdSchema, YnabPlanIdSchema } from "./domain-schema.ts";
import type { SatispayTransactionId, YnabAccountId } from "./domain.ts";
import type { YnabAccounts } from "./ynab-contract.ts";
import { Effect, Redacted, Schema, Schedule } from "effect";
import { AppConfig, type YnabTarget } from "./config.ts";
import type { YnabServiceApi } from "./ynab-contract.ts";
export type { YnabEnv } from "./config.ts";
import {
  YnabError,
  YnabTransportError,
  YnabHttpError,
  YnabResponseError,
  YnabAccountError,
  YnabWriteDisabledError,
  YnabImportRejectedError,
  YnabImportUncertainError,
} from "./errors.ts";
export { YnabError } from "./errors.ts";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { ImportCandidate, ImportPlan } from "./import-plan.ts";

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
        cleared: "cleared" as const,
        approved: false,
        import_id,
      })),
    { concurrency: 4 },
  );
}

/** Acquire infrastructure once; all returned operations are dependency-free. */
export const makeYnabClient = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const config = yield* AppConfig;
  const apiRequest = (path: string, token: string, method: "GET" | "POST") => {
    const url = "https://api.ynab.com/v1" + path;
    return (method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)).pipe(
      HttpClientRequest.setHeader("Authorization", "Bearer " + token),
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
        const parsed: unknown = yield* res.json.pipe(
          Effect.mapError(() => new YnabResponseError({ reason: "Json" })),
        );
        if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !parsed.data) {
          return yield* Effect.fail(new YnabResponseError({ reason: "Json" }));
        }
        return parsed.data;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new YnabTransportError({ reason: "Timeout" })),
      }),
      observeOperation(request.method === "GET" ? "ynab.read" : "ynab.write"),
    );
  }

  const readApiEffect = (path: string, token: string) =>
    apiEffect(apiRequest(path, token, "GET")).pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.exponential("200 millis"),
        while: (error) =>
          error._tag === "YnabTransportError" ||
          (error._tag === "YnabHttpError" && [502, 503, 504].includes(error.status)),
      }),
    );

  const postApiEffect = (path: string, token: string, body: unknown) =>
    Effect.gen(function* () {
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
    const token = Redacted.value(yield* config.token);
    const rawPlans = yield* readApiEffect("/plans", token);
    const { plans } = yield* Schema.decodeUnknownEffect(PlansSchema)(rawPlans).pipe(
      Effect.mapError(() => new YnabResponseError({ reason: "Plans" })),
    );
    const matches: Array<YnabAccounts["matches"][number]> = [];
    for (const plan of plans.slice(0, 20)) {
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
    return { matches };
  });

  const validateTargetAccountEffect = Effect.fn("satispay.ynab.validateAccount")(function* (
    target: YnabTarget,
  ) {
    const token = Redacted.value(target.token);
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
    if (plan.counts.rejected > 0)
      return yield* Effect.fail(
        new YnabImportRejectedError({
          reason: "AmbiguousMovements",
        }),
      );
    if (plan.candidates.length > 100)
      return yield* Effect.fail(new YnabImportRejectedError({ reason: "BatchTooLarge" }));
    const target = yield* config.target;
    yield* validateTargetAccountEffect(target);
    if (!plan.candidates.length)
      return { submitted: 0, processed: 0, duplicateImports: 0, ynabReportedTransactionIds: 0 };
    const transactions = yield* buildYnabTransactionsEffect(plan.candidates, target.accountId);
    const token = Redacted.value(target.token);
    const rawResult = yield* postApiEffect(
      "/plans/" + encodeURIComponent(target.planId) + "/transactions",
      token,
      { transactions },
    );
    const data = yield* Schema.decodeUnknownEffect(ImportResultSchema)(rawResult).pipe(
      Effect.mapError(
        () =>
          new YnabImportUncertainError({
            reason: { _tag: "Contract" },
          }),
      ),
    );
    const submitted = transactions.length;
    const duplicateImports = data.duplicate_import_ids.length;
    if (duplicateImports > submitted)
      return yield* Effect.fail(
        new YnabImportUncertainError({
          reason: { _tag: "DuplicateCount" },
        }),
      );
    return {
      submitted,
      processed: submitted - duplicateImports,
      duplicateImports,
      ynabReportedTransactionIds: data.transaction_ids.length,
    };
  });

  return {
    findAccounts: findSatispayAccountsEffect(),
    validateAccount: Effect.flatMap(config.target, validateTargetAccountEffect),
    importPlan: sendToYnabEffect,
  } satisfies YnabServiceApi;
});
