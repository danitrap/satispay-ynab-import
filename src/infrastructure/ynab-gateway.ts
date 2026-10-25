import { AppConfig } from "../application/app-config.ts";
import { YnabPlanCatalog } from "../application/list-ynab-accounts.ts";
import {
  YnabGateway,
  YnabGatewayError,
  type CreatedImportBatch,
  type YnabAccount,
  type YnabGatewayOperation,
  type YnabTransaction,
} from "../application/ynab-gateway.ts";
import type { YnabAccountId, YnabPlanId } from "../domain.ts";
import { YnabAccountIdSchema, YnabPlanIdSchema } from "../domain-schema.ts";
import { observeOperation } from "../telemetry.ts";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// Preserve the existing envelope contract separately from operation-specific payloads.
const YnabEnvelopeSchema = Schema.Struct({
  data: Schema.Unknown.check(Schema.makeFilter((value) => Boolean(value))),
});

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

const toAccount = (account: typeof AccountSchema.Type): YnabAccount => ({
  id: account.id,
  name: account.name,
  onBudget: account.on_budget,
  closed: account.closed,
  deleted: account.deleted ?? false,
});

const toApiTransaction = (transaction: YnabTransaction) => ({
  account_id: transaction.accountId,
  date: transaction.date,
  amount: transaction.amountMilliunits,
  payee_name: transaction.payee,
  ...(transaction.memo ? { memo: transaction.memo } : {}),
  cleared: transaction.cleared,
  approved: transaction.approved,
  ...(transaction.flagColor ? { flag_color: transaction.flagColor } : {}),
  import_id: transaction.importId,
});

const gatewayError = (operation: YnabGatewayOperation, reason: YnabGatewayError["reason"]) =>
  new YnabGatewayError({ operation, reason });

/** Live YNAB calls. Reads may retry; a transaction POST is a single attempt. */
const makeYnabApi = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const config = yield* AppConfig;
  const apiRequest = (path: string, token: Redacted.Redacted<string>, method: "GET" | "POST") => {
    const url = "https://api.ynab.com/v1" + path;
    return (method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.acceptJson,
    );
  };

  const apiEffect = (
    request: HttpClientRequest.HttpClientRequest,
    operation: YnabGatewayOperation,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError(() => gatewayError(operation, { _tag: "Network" })));
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            gatewayError(operation, { _tag: "Http", status: response.status }),
          );
        }
        const { data } = yield* HttpClientResponse.schemaBodyJson(YnabEnvelopeSchema)(
          response,
        ).pipe(Effect.mapError(() => gatewayError(operation, { _tag: "Response" })));
        return data;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(gatewayError(operation, { _tag: "Timeout" })),
      }),
      observeOperation(request.method === "GET" ? "ynab.read" : "ynab.write"),
    );

  // GET transport failures and HTTP 502/503/504 may be repeated. Decoding failures are not.
  const readApi = (request: HttpClientRequest.HttpClientRequest, operation: YnabGatewayOperation) =>
    apiEffect(request, operation).pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.exponential("200 millis"),
        while: (error) =>
          error.reason._tag === "Network" ||
          error.reason._tag === "Timeout" ||
          (error.reason._tag === "Http" && [502, 503, 504].includes(error.reason.status)),
      }),
    );

  const listPlans = Effect.fn("satispay.ynab.listPlans")(function* () {
    const token = yield* config.token;
    const data = yield* readApi(apiRequest("/plans", token, "GET"), "listPlans");
    const decoded = yield* Schema.decodeUnknownEffect(PlansSchema)(data).pipe(
      Effect.mapError(() => gatewayError("listPlans", { _tag: "Contract" })),
    );
    return decoded.plans;
  });

  const listAccounts = Effect.fn("satispay.ynab.listAccounts")(function* (planId: YnabPlanId) {
    const token = yield* config.token;
    const data = yield* readApi(
      apiRequest("/plans/" + encodeURIComponent(planId) + "/accounts", token, "GET"),
      "listAccounts",
    );
    const decoded = yield* Schema.decodeUnknownEffect(AccountsSchema)(data).pipe(
      Effect.mapError(() => gatewayError("listAccounts", { _tag: "Contract" })),
    );
    return decoded.accounts.map(toAccount);
  });

  const readAccount = Effect.fn("satispay.ynab.readAccount")(function* (
    planId: YnabPlanId,
    accountId: YnabAccountId,
  ) {
    const token = yield* config.token;
    const data = yield* readApi(
      apiRequest(
        "/plans/" + encodeURIComponent(planId) + "/accounts/" + encodeURIComponent(accountId),
        token,
        "GET",
      ),
      "readAccount",
    );
    const decoded = yield* Schema.decodeUnknownEffect(AccountResponseSchema)(data).pipe(
      Effect.mapError(() => gatewayError("readAccount", { _tag: "Contract" })),
    );
    return toAccount(decoded.account);
  });

  const createImportBatch = Effect.fn("satispay.ynab.createImportBatch")(function* (input: {
    readonly planId: YnabPlanId;
    readonly transactions: ReadonlyArray<YnabTransaction>;
  }) {
    const token = yield* config.token;
    const request = yield* HttpClientRequest.bodyJson(
      apiRequest("/plans/" + encodeURIComponent(input.planId) + "/transactions", token, "POST"),
      { transactions: input.transactions.map(toApiTransaction) },
    ).pipe(Effect.mapError(() => gatewayError("createImportBatch", { _tag: "Encode" })));
    // Single attempt. The import use case decides whether the outcome is uncertain.
    const data = yield* apiEffect(request, "createImportBatch");
    const decoded = yield* Schema.decodeUnknownEffect(ImportResultSchema)(data).pipe(
      Effect.mapError(() => gatewayError("createImportBatch", { _tag: "Contract" })),
    );
    const created: CreatedImportBatch = {
      transactionIds: decoded.transaction_ids,
      duplicateImportIds: decoded.duplicate_import_ids,
    };
    return created;
  });

  return { listPlans, listAccounts, readAccount, createImportBatch };
});

export const ynabGatewayLayer = Layer.mergeAll(
  Layer.effect(
    YnabGateway,
    Effect.map(makeYnabApi, ({ listAccounts, readAccount, createImportBatch }) => ({
      listAccounts,
      readAccount,
      createImportBatch,
    })),
  ),
  Layer.effect(
    YnabPlanCatalog,
    Effect.map(makeYnabApi, ({ listPlans }) => ({ listPlans })),
  ),
);
