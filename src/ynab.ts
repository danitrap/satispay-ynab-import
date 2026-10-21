import { Effect, Redacted, Schema } from "effect";
import { AppConfig } from "./config.ts";
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
  id: Schema.String,
  name: Schema.String,
  on_budget: Schema.Boolean,
  closed: Schema.Boolean,
  deleted: Schema.optionalKey(Schema.Boolean),
});
const PlansSchema = Schema.Struct({
  plans: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
const AccountsSchema = Schema.Struct({ accounts: Schema.Array(AccountSchema) });
const AccountResponseSchema = Schema.Struct({ account: AccountSchema });
const ImportResultSchema = Schema.Struct({
  transaction_ids: Schema.Array(Schema.String),
  duplicate_import_ids: Schema.Array(Schema.String),
});

/** One Effect for transport, HTTP status and response decoding; errors are typed. */
function apiEffect(path: string, token: string, method: "GET" | "POST" = "GET", body?: unknown) {
  const responseError = () =>
    method === "POST"
      ? new YnabImportUncertainError({
          message: "YNAB returned unexpected JSON. Check import status before repeating.",
        })
      : new YnabResponseError({ message: "YNAB returned unexpected JSON." });
  const execute = Effect.gen(function* () {
    const url = "https://api.ynab.com/v1" + path;
    const initial = (
      method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url)
    ).pipe(
      HttpClientRequest.setHeader("Authorization", "Bearer " + token),
      HttpClientRequest.acceptJson,
    );
    const request =
      body === undefined
        ? initial
        : yield* HttpClientRequest.bodyJson(initial, body).pipe(
            Effect.mapError(() => new YnabError("Cannot encode YNAB request")),
          );
    const res = yield* HttpClient.execute(request).pipe(
      Effect.mapError(() =>
        method === "POST"
          ? new YnabImportUncertainError({
              message: "YNAB network error. Check import status before repeating.",
            })
          : new YnabTransportError({ message: "YNAB network error." }),
      ),
    );
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(
        method === "POST" && res.status >= 500
          ? new YnabImportUncertainError({
              message: "YNAB API HTTP " + res.status + ". Check import status before repeating.",
            })
          : new YnabHttpError({
              status: res.status,
              message: "YNAB API HTTP " + res.status + ". Check your plan, account and token.",
            }),
      );
    }
    const parsed: unknown = yield* res.json.pipe(Effect.mapError(responseError));
    if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !parsed.data) {
      return yield* Effect.fail(responseError());
    }
    return parsed.data;
  });
  return execute;
}

export function findSatispayAccountsEffect() {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const token = Redacted.value(yield* config.token);
    const rawPlans = yield* apiEffect("/plans", token, "GET");
    const { plans } = yield* Schema.decodeUnknownEffect(PlansSchema)(rawPlans).pipe(
      Effect.mapError(() => new YnabResponseError({ message: "Cannot list YNAB plans" })),
    );
    const matches: {
      planId: string;
      planName: string;
      accountId: string;
      accountName: string;
      onBudget: boolean;
    }[] = [];
    for (const plan of plans.slice(0, 20)) {
      const rawAccounts = yield* apiEffect(
        "/plans/" + encodeURIComponent(plan.id) + "/accounts",
        token,
        "GET",
      );
      const { accounts } = yield* Schema.decodeUnknownEffect(AccountsSchema)(rawAccounts).pipe(
        Effect.mapError(() => new YnabResponseError({ message: "Cannot list YNAB accounts" })),
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
}

export function validateTargetAccountEffect() {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const target = yield* config.target;
    const token = Redacted.value(target.token);
    const rawAccount = yield* apiEffect(
      "/plans/" +
        encodeURIComponent(target.planId) +
        "/accounts/" +
        encodeURIComponent(target.accountId),
      token,
      "GET",
    );
    const { account } = yield* Schema.decodeUnknownEffect(AccountResponseSchema)(rawAccount).pipe(
      Effect.mapError(
        () =>
          new YnabAccountError({
            message: "Target must be an active on-budget account named Satispay",
          }),
      ),
    );
    if (
      !account ||
      account.id !== target.accountId ||
      !account.name.toLowerCase().includes("satispay") ||
      !account.on_budget ||
      account.closed ||
      account.deleted
    ) {
      return yield* Effect.fail(
        new YnabAccountError({
          message: "Target must be an active on-budget account named Satispay",
        }),
      );
    }
    return account;
  });
}

/** Preserve the original SHA-256 namespace and 36-character import IDs exactly. */
export function importIdEffect(satispayId: string) {
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

export function buildYnabTransactionsEffect(candidates: ImportCandidate[], accountId: string) {
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

export function sendToYnabEffect(plan: ImportPlan) {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    if (!(yield* config.writesEnabled))
      return yield* Effect.fail(
        new YnabWriteDisabledError({ message: "YNAB write disabled: set YNAB_WRITE_ENABLED=true" }),
      );
    if (plan.counts.rejected > 0)
      return yield* Effect.fail(
        new YnabImportRejectedError({
          message: "Ambiguous transactions found: no YNAB writes performed",
        }),
      );
    if (plan.candidates.length > 100)
      return yield* Effect.fail(
        new YnabImportRejectedError({ message: "Over 100 movements: use a shorter export" }),
      );
    yield* validateTargetAccountEffect();
    if (!plan.candidates.length)
      return { submitted: 0, processed: 0, duplicateImports: 0, ynabReportedTransactionIds: 0 };
    const target = yield* config.target;
    const transactions = yield* buildYnabTransactionsEffect(plan.candidates, target.accountId);
    const token = Redacted.value(target.token);
    const rawResult = yield* apiEffect(
      "/plans/" + encodeURIComponent(target.planId) + "/transactions",
      token,
      "POST",
      { transactions },
    );
    const data = yield* Schema.decodeUnknownEffect(ImportResultSchema)(rawResult).pipe(
      Effect.mapError(
        () =>
          new YnabImportUncertainError({
            message: "Unexpected YNAB response: verify results in YNAB before retrying",
          }),
      ),
    );
    const submitted = transactions.length;
    const duplicateImports = data.duplicate_import_ids.length;
    if (duplicateImports > submitted)
      return yield* Effect.fail(
        new YnabImportUncertainError({
          message: "Unexpected YNAB duplicate import count: verify results in YNAB before retrying",
        }),
      );
    return {
      submitted,
      processed: submitted - duplicateImports,
      duplicateImports,
      ynabReportedTransactionIds: data.transaction_ids.length,
    };
  });
}
