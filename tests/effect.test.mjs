import { workbookReaderLayer } from "../src/infrastructure/workbook-reader.ts";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { handleRequestEffect } from "../src/http/handle-request.ts";
import { importPrepared, reportedImportCounts } from "../src/application/import-prepared.ts";
import { listYnabAccounts } from "../src/application/list-ynab-accounts.ts";
import { importIdentity, toYnabTransaction } from "../src/application/ynab-transaction.ts";
import { requestLiveLayer } from "../src/main.ts";
import { readSheetEffect } from "../src/application/workbook-reader.ts";
import { emptyPreparedImport, preparedFromCandidates } from "./support/candidate-prepared.mjs";

test("Cloudflare request handler is an Effect and retains unauthorized protection", async () => {
  const program = handleRequestEffect(
    new Request("https://example.invalid/import", { method: "POST" }),
  );
  assert.equal(Effect.isEffect(program), true);
  const res = await Effect.runPromise(
    program.pipe(Effect.provide(requestLiveLayer({ UPLOAD_TOKEN: "secret" }))),
  );
  assert.equal(res.status, 401);
});
test("Effect YNAB program prevents writes while disabled", async () => {
  const result = await Effect.runPromiseExit(
    importPrepared(emptyPreparedImport).pipe(
      Effect.provide(requestLiveLayer({ YNAB_WRITE_ENABLED: "false" })),
    ),
  );
  assert.equal(result._tag, "Failure");
});
test("Effect SHA-256 import ids preserve deterministic legacy form", async () => {
  const a = await Effect.runPromise(importIdentity("a-stable-id"));
  const b = await Effect.runPromise(importIdentity("a-stable-id"));
  assert.equal(a, b);
  assert.equal(a.length, 36);
  assert.match(a, /^SPS:[a-f0-9]{32}$/);
});
test("invalid Excel produces typed WorkbookError", async () => {
  const result = await Effect.runPromiseExit(
    readSheetEffect(new TextEncoder().encode("not a workbook").buffer).pipe(
      Effect.provide(workbookReaderLayer),
    ),
  );
  assert.equal(result._tag, "Failure");
});

test("Effect decodes YNAB plans instead of trusting an untyped response", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ data: { plans: [{ id: 123, name: "wrong" }] } }), {
      status: 200,
    });
  await assert.rejects(
    Effect.runPromise(
      listYnabAccounts.pipe(Effect.provide(requestLiveLayer({ YNAB_TOKEN: "test" }, fetchFn))),
    ),
    /Cannot list YNAB plans/,
  );
});
test("Effect validates account schema and never posts to unexpected account data", async () => {
  const prepared = preparedFromCandidates([
    {
      satispayId: "a",
      date: "2026-10-18",
      payee: "Shop",
      memo: "",
      amountMilliunits: -1000,
      type: "Altro",
    },
  ]);
  const env = {
    YNAB_TOKEN: "test",
    YNAB_PLAN_ID: "plan",
    YNAB_ACCOUNT_ID: "target",
    YNAB_WRITE_ENABLED: "true",
  };
  let postCount = 0;
  const fetchFn = async (_url, options) => {
    if (options.method === "POST") postCount++;
    return new Response(
      JSON.stringify({
        data: { account: { id: "target", name: "Satispay", closed: false, on_budget: "true" } },
      }),
      { status: 200 },
    );
  };
  await assert.rejects(
    Effect.runPromise(
      importPrepared(prepared).pipe(Effect.provide(requestLiveLayer(env, fetchFn))),
    ),
    /Target must be/,
  );
  assert.equal(postCount, 0);
});
test("Effect refuses malformed successful YNAB POST responses without retrying writes", async () => {
  const prepared = preparedFromCandidates([
    {
      satispayId: "unique",
      date: "2026-10-18",
      payee: "Shop",
      memo: "",
      amountMilliunits: -1500,
      type: "Altro",
    },
  ]);
  const env = {
    YNAB_TOKEN: "test",
    YNAB_PLAN_ID: "plan",
    YNAB_ACCOUNT_ID: "target",
    YNAB_WRITE_ENABLED: "true",
  };
  let writes = 0;
  const fetchFn = async (_url, options) => {
    if (options.method === "GET")
      return new Response(
        JSON.stringify({
          data: { account: { id: "target", name: "Satispay", closed: false, on_budget: true } },
        }),
        { status: 200 },
      );
    writes++;
    return new Response(
      JSON.stringify({ data: { transaction_ids: ["tx-1"], duplicate_import_ids: "not-an-array" } }),
      { status: 200 },
    );
  };
  await assert.rejects(
    Effect.runPromise(
      importPrepared(prepared).pipe(Effect.provide(requestLiveLayer(env, fetchFn))),
    ),
    /Unexpected YNAB response/,
  );
  assert.equal(writes, 1);
});
test("Effect import response distinguishes matched IDs from actual imported movements", async () => {
  const prepared = preparedFromCandidates([
    {
      satispayId: "unique",
      date: "2026-10-18",
      payee: "Shop",
      memo: "",
      amountMilliunits: -1500,
      type: "Altro",
    },
  ]);
  const env = {
    YNAB_TOKEN: "test",
    YNAB_PLAN_ID: "plan",
    YNAB_ACCOUNT_ID: "target",
    YNAB_WRITE_ENABLED: "true",
  };
  const fetchFn = async (_url, options) => {
    if (options.method === "GET")
      return new Response(
        JSON.stringify({
          data: { account: { id: "target", name: "Satispay", closed: false, on_budget: true } },
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        data: { transaction_ids: ["original", "matched"], duplicate_import_ids: [] },
      }),
      { status: 200 },
    );
  };
  const result = await Effect.runPromise(
    importPrepared(prepared).pipe(
      Effect.provide(requestLiveLayer(env, fetchFn)),
      Effect.map(reportedImportCounts),
    ),
  );
  assert.deepEqual(result, {
    submitted: 1,
    processed: 1,
    duplicateImports: 0,
    ynabReportedTransactionIds: 2,
    confirmed: 1,
    uncertain: 0,
    failed: 0,
    notAttempted: 0,
  });
});
test("Effect preserves input ordering when hashing imported IDs concurrently", async () => {
  const rows = ["first", "second", "third", "fourth", "fifth"].map((satispayId) => ({
    satispayId,
    date: "2026-10-18",
    payee: satispayId,
    memo: "",
    amountMilliunits: -1000,
    type: "Altro",
  }));
  const transactions = await Effect.runPromise(
    Effect.forEach(
      preparedFromCandidates(rows).movements,
      (candidate) => toYnabTransaction(candidate, "account"),
      { concurrency: 4 },
    ),
  );
  assert.deepEqual(
    transactions.map((transaction) => transaction.payee),
    rows.map((row) => row.payee),
  );
  assert.equal(new Set(transactions.map((transaction) => transaction.importId)).size, rows.length);
});

test("a lost POST response is a typed uncertain import and is never retried", async () => {
  let writes = 0;
  const fetchFn = async (_url, options) => {
    if (options.method === "GET") {
      return Response.json({
        data: { account: { id: "target", name: "Satispay", closed: false, on_budget: true } },
      });
    }
    writes++;
    throw new Error("transport details must stay private");
  };
  const error = await Effect.runPromise(
    importPrepared(
      preparedFromCandidates([
        {
          satispayId: "unique",
          date: "2026-10-18",
          payee: "Shop",
          memo: "",
          amountMilliunits: -1000,
          type: "Altro",
        },
      ]),
    ).pipe(
      Effect.provide(
        requestLiveLayer(
          {
            YNAB_TOKEN: "test",
            YNAB_PLAN_ID: "plan",
            YNAB_ACCOUNT_ID: "target",
            YNAB_WRITE_ENABLED: "true",
          },
          fetchFn,
        ),
      ),
      Effect.flip,
    ),
  );
  assert.equal(error._tag, "ImportBatchError");
  assert.deepEqual(error.failure, { _tag: "Uncertain", reason: "Network" });
  assert.equal(error.outcome.uncertain, 1);
  assert.match(error.message, /verify|Check import status/i);
  assert.equal(error.message.includes("transport details"), false);
  assert.equal(writes, 1);
});
