import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { importPrepared } from "../src/application/import-prepared.ts";
import { listYnabAccounts, YnabPlanCatalog } from "../src/application/list-ynab-accounts.ts";
import { YnabGateway, YnabGatewayError } from "../src/application/ynab-gateway.ts";
import { appConfigLayer } from "../src/infrastructure/app-config.ts";
import { requestLiveLayer } from "../src/main.ts";
import { emptyPreparedImport, preparedFromCandidates } from "./support/candidate-prepared.mjs";

const openAccount = {
  id: "wallet",
  name: "Satispay",
  onBudget: true,
  closed: false,
  deleted: false,
};
const candidate = {
  satispayId: "test",
  date: "2026-10-18",
  amountMilliunits: -1000,
  payee: "Shop",
  memo: "",
  type: "Altro",
};

test("a fake gateway lists Satispay accounts and imports without HTTP", async () => {
  const gateway = {
    listAccounts: () =>
      Effect.succeed([
        openAccount,
        { id: "other", name: "Revolut", onBudget: true, closed: false, deleted: false },
      ]),
    readAccount: () => Effect.succeed(openAccount),
    createImportBatch: () =>
      Effect.succeed({ transactionIds: [], duplicateImportIds: ["SPS:already"] }),
  };
  const plans = { listPlans: () => Effect.succeed([{ id: "test", name: "Budget" }]) };
  const accounts = await Effect.runPromise(
    listYnabAccounts.pipe(
      Effect.provideService(YnabGateway, gateway),
      Effect.provideService(YnabPlanCatalog, plans),
      Effect.provide(appConfigLayer({ YNAB_TOKEN: "synthetic" })),
    ),
  );
  assert.equal(accounts.matches.length, 1);
  assert.equal(accounts.matches[0].accountName, "Satispay");
  assert.equal(accounts.truncated, false);
  const outcome = await Effect.runPromise(
    importPrepared(preparedFromCandidates([candidate])).pipe(
      Effect.provideService(YnabGateway, gateway),
      Effect.provide(
        appConfigLayer({
          YNAB_TOKEN: "synthetic",
          YNAB_PLAN_ID: "plan",
          YNAB_ACCOUNT_ID: "wallet",
          YNAB_WRITE_ENABLED: "true",
        }),
      ),
    ),
  );
  assert.equal(outcome.duplicate, 1);
  assert.equal(outcome.confirmed - outcome.duplicate, 0);
});

test("a fake gateway failure stays a typed Effect failure", async () => {
  const exit = await Effect.runPromiseExit(
    importPrepared(preparedFromCandidates([candidate])).pipe(
      Effect.provideService(YnabGateway, {
        listAccounts: () => Effect.die("import does not list accounts"),
        readAccount: () => Effect.succeed(openAccount),
        createImportBatch: () =>
          Effect.fail(
            new YnabGatewayError({ operation: "createImportBatch", reason: { _tag: "Network" } }),
          ),
      }),
      Effect.provide(
        appConfigLayer({
          YNAB_TOKEN: "synthetic",
          YNAB_PLAN_ID: "plan",
          YNAB_ACCOUNT_ID: "wallet",
          YNAB_WRITE_ENABLED: "true",
        }),
      ),
    ),
  );
  assert.equal(exit._tag, "Failure");
});

test("live Layer with fake transport rejects malformed YNAB account before any POST", async () => {
  let posts = 0;
  const mockFetch = async (_url, init) => {
    if (init?.method === "POST") posts++;
    return new Response(
      JSON.stringify({
        data: { account: { id: "wallet", name: "Satispay", on_budget: "yes", closed: false } },
      }),
      { status: 200 },
    );
  };
  const env = {
    YNAB_TOKEN: "fake",
    YNAB_PLAN_ID: "plan",
    YNAB_ACCOUNT_ID: "wallet",
    YNAB_WRITE_ENABLED: "true",
  };
  await assert.rejects(
    Effect.runPromise(
      importPrepared(preparedFromCandidates([candidate])).pipe(
        Effect.provide(requestLiveLayer(env, mockFetch)),
      ),
    ),
    /Target must be/,
  );
  assert.equal(posts, 0);
});

test("disabled live Layer prevents all network calls", async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    throw new Error("Should not call network");
  };
  await assert.rejects(
    Effect.runPromise(
      importPrepared(emptyPreparedImport).pipe(
        Effect.provide(requestLiveLayer({ YNAB_WRITE_ENABLED: "false" }, mockFetch)),
      ),
    ),
    /disabled/,
  );
  assert.equal(calls, 0);
});
