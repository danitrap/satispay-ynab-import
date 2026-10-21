import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { buildImportPlan } from "../src/import-plan.ts";
import { handleRequestEffect } from "../src/index.ts";
import { importPlanEffect, requestLiveLayer } from "../src/ynab-service.ts";
import { WorkbookReader } from "../src/workbook-reader.ts";

const headers = [
  "Data",
  "Nome",
  "Descrizione",
  "Importo",
  "Tipo",
  "Stato",
  "Disponibilità",
  "ID",
  "Buoni Pasto",
];
const row = (id, amount = -1, options = {}) => [
  options.date ?? "2026-10-18",
  "Synthetic Shop",
  options.memo ?? "Synthetic description",
  options.nominal ?? amount,
  options.type ?? "🏬 a un Negozio",
  options.status ?? "✅ Approvato",
  amount,
  id,
  options.benefit ?? null,
];
const env = {
  UPLOAD_TOKEN: "synthetic-upload",
  YNAB_TOKEN: "synthetic-ynab",
  YNAB_PLAN_ID: "plan",
  YNAB_ACCOUNT_ID: "wallet",
  YNAB_WRITE_ENABLED: "true",
  YNAB_IMPORT_FROM: "2026-10-01",
};
const account = { id: "wallet", name: "Satispay", on_budget: true, closed: false };
const success = (transactions, duplicates = []) =>
  Response.json({
    data: {
      transaction_ids: transactions.map((transaction) => transaction.import_id),
      duplicate_import_ids: duplicates,
    },
  });
const makeRequest = (signal) =>
  new Request("https://local.invalid/import", {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-upload", "X-Confirm-Import": "yes" },
    body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    signal,
  });
const program = (rows, fetchFn, request = makeRequest()) =>
  handleRequestEffect(request).pipe(
    Effect.provideService(WorkbookReader, { read: () => Effect.succeed(rows) }),
    Effect.provide(requestLiveLayer(env, fetchFn)),
  );

test("ambiguous refunds reach YNAB for review alongside valid rows and exclusions", async () => {
  const rows = [
    headers,
    row("refund", 20.23, { type: "🔄 Rimborso", memo: "Source description ".repeat(60) }),
    row("purchase-a", -4.23, { date: "2026-09-29", nominal: -20.23, benefit: -16 }),
    row("purchase-b", -12.23, { date: "2026-09-28", nominal: -20.23, benefit: -8 }),
    row("valid", -2),
    row("invalid", 1.001),
  ];
  let payload;
  const response = await Effect.runPromise(
    program(rows, async (_url, init) => {
      if (init.method === "GET") return Response.json({ data: { account } });
      payload = JSON.parse(init.body).transactions;
      return success(payload);
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.processed, 2);
  assert.equal(body.provisional, 1);
  assert.equal(body.rejected, 1);
  assert.equal(body.requiresReview, 2);
  assert.equal(body.olderThanStart, 2);
  assert.deepEqual(body.reviewIssues, { ambiguous_refund_purchase: 1 });
  const refund = payload.find((transaction) => transaction.amount > 0);
  assert.equal(refund.amount, 20230);
  assert.equal(refund.payee_name, "Synthetic Shop");
  assert.equal(refund.cleared, "uncleared");
  assert.equal(refund.approved, false);
  assert.equal(refund.flag_color, "orange");
  assert.match(refund.memo, /Multiple original purchases/);
  assert.match(refund.memo, /provisional wallet amount/);
  assert.match(refund.memo, /correct the amount/);
  assert.match(refund.memo, /Source description/);
  assert.ok(refund.memo.length <= 500);
  const normal = payload.find((transaction) => transaction.amount < 0);
  assert.equal(normal.cleared, "cleared");
  assert.equal(normal.flag_color, undefined);
  assert.equal(normal.memo, "Synthetic description");
  const serialized = JSON.stringify(body);
  for (const privateValue of ["Synthetic Shop", "Synthetic description", refund.import_id])
    assert.equal(serialized.includes(privateValue), false);
});

test("unusable essential data never becomes a provisional YNAB transaction", async () => {
  const rows = [
    headers,
    row("valid"),
    row("bad-date", -1, { date: "2026-02-30" }),
    row("", -1),
    row("duplicate"),
    row("duplicate"),
    row("invalid-amount", "1.23"),
    row("pending", -1, { status: "In attesa" }),
    row("invalid-refund", -5, { type: "🔄 Rimborso" }),
  ];
  let submitted;
  const response = await Effect.runPromise(
    program(rows, async (_url, init) => {
      if (init.method === "GET") return Response.json({ data: { account } });
      submitted = JSON.parse(init.body).transactions;
      return success(submitted);
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.rejected, 7);
  assert.equal(body.provisional, 0);
  assert.equal(body.processed, 1);
  assert.equal(submitted.length, 1);
});

test("10,000 candidates are submitted in 20 sequential batches with exact aggregate counts", async () => {
  const rows = [headers, ...Array.from({ length: 10_000 }, (_, index) => row(`tx-${index}`))];
  const plan = buildImportPlan(rows, env.YNAB_IMPORT_FROM);
  const sizes = [],
    ids = new Set();
  let active = 0,
    reads = 0;
  const result = await Effect.runPromise(
    importPlanEffect(plan).pipe(
      Effect.provide(
        requestLiveLayer(env, async (_url, init) => {
          if (init.method === "GET") {
            reads++;
            return Response.json({ data: { account } });
          }
          assert.equal(active++, 0);
          await Promise.resolve();
          const transactions = JSON.parse(init.body).transactions;
          sizes.push(transactions.length);
          for (const transaction of transactions) {
            assert.equal(ids.has(transaction.import_id), false);
            ids.add(transaction.import_id);
          }
          active--;
          return success(
            transactions,
            transactions.slice(0, 5).map((transaction) => transaction.import_id),
          );
        }),
      ),
    ),
  );
  assert.equal(reads, 1);
  assert.deepEqual(sizes, Array(20).fill(500));
  assert.equal(ids.size, 10_000);
  assert.deepEqual(result, {
    submitted: 10_000,
    confirmed: 10_000,
    processed: 9900,
    duplicateImports: 100,
    ynabReportedTransactionIds: 10_000,
    uncertain: 0,
    failed: 0,
    notAttempted: 0,
  });
});

test("more than 10,000 candidates fail before contacting YNAB", async () => {
  const plan = buildImportPlan(
    [headers, ...Array.from({ length: 10_001 }, (_, index) => row(`tx-${index}`))],
    env.YNAB_IMPORT_FROM,
  );
  let calls = 0;
  const error = await Effect.runPromise(
    importPlanEffect(plan).pipe(
      Effect.provide(
        requestLiveLayer(env, async () => {
          calls++;
          throw Error("Unexpected request");
        }),
      ),
      Effect.flip,
    ),
  );
  assert.equal(error._tag, "YnabImportRejectedError");
  assert.equal(error.reason, "BatchTooLarge");
  assert.match(error.message, /10,000/);
  assert.equal(calls, 0);
});

test("a failed middle batch retains confirmed progress, stops and is never retried", async () => {
  const rows = [headers, ...Array.from({ length: 1001 }, (_, index) => row(`tx-${index}`))];
  for (const [failure, uncertain] of [
    [
      () => {
        throw Error("private transport details");
      },
      true,
    ],
    [() => new Response("private server details", { status: 503 }), true],
    [() => new Response("invalid JSON"), true],
    [() => Response.json({ data: {} }), true],
    [
      () =>
        Response.json({
          data: { transaction_ids: [], duplicate_import_ids: Array(501).fill("duplicate") },
        }),
      true,
    ],
    [() => new Response("rejected", { status: 400 }), false],
    [() => new Response("rate limited", { status: 429 }), false],
  ]) {
    let writes = 0;
    const response = await Effect.runPromise(
      program(rows, async (_url, init) => {
        if (init.method === "GET") return Response.json({ data: { account } });
        writes++;
        const transactions = JSON.parse(init.body).transactions;
        if (writes === 2) return failure();
        return success(
          transactions,
          transactions.slice(0, 10).map((transaction) => transaction.import_id),
        );
      }),
    );
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.mode, "import-failed");
    assert.equal(writes, 2);
    assert.equal(body.submitted, 1000);
    assert.equal(body.confirmed, 500);
    assert.equal(body.processed, 490);
    assert.equal(body.imported, 490);
    assert.equal(body.duplicateImports, 10);
    assert.equal(body.uncertain, uncertain ? 500 : 0);
    assert.equal(body.failed, uncertain ? 0 : 500);
    assert.equal(body.notAttempted, 1);
    if (uncertain) assert.match(body.error, /verify|Check import status/i);
    assert.equal(JSON.stringify(body).includes("private"), false);
    assert.equal(JSON.stringify(body).includes("Synthetic Shop"), false);
  }
});

test("disconnecting during a later batch aborts the transport without starting more batches", async () => {
  const rows = [headers, ...Array.from({ length: 1001 }, (_, index) => row(`tx-${index}`))];
  const abort = new AbortController();
  let writes = 0,
    aborted = false,
    started;
  const pendingPost = new Promise((resolve) => {
    started = resolve;
  });
  const pending = Effect.runPromise(
    program(
      rows,
      async (_url, init) => {
        if (init.method === "GET") return Response.json({ data: { account } });
        writes++;
        if (writes === 1) return success(JSON.parse(init.body).transactions);
        started();
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Error("Disconnected"));
            },
            { once: true },
          ),
        );
      },
      makeRequest(abort.signal),
    ),
    { signal: abort.signal },
  );
  await pendingPost;
  abort.abort();
  await assert.rejects(pending);
  assert.equal(writes, 2);
  assert.equal(aborted, true);
});

test("reimporting a now-resolved refund preserves manual YNAB corrections via stable IDs", async () => {
  const refund = row("refund", 20, { type: "🔄 Rimborso" });
  const transactions = new Map();
  const methods = [];
  const fetchFn = async (_url, init) => {
    methods.push(init.method);
    if (init.method === "GET") return Response.json({ data: { account } });
    const payload = JSON.parse(init.body).transactions;
    const duplicates = [];
    for (const transaction of payload) {
      if (transactions.has(transaction.import_id)) duplicates.push(transaction.import_id);
      else transactions.set(transaction.import_id, transaction);
    }
    return success(payload, duplicates);
  };
  const first = await Effect.runPromise(program([headers, refund], fetchFn));
  assert.equal((await first.json()).provisional, 1);
  const [id, stored] = [...transactions.entries()][0];
  const corrected = {
    ...stored,
    amount: 4000,
    memo: "Reviewed manually",
    flag_color: null,
    cleared: "cleared",
    approved: true,
  };
  transactions.set(id, corrected);
  const second = await Effect.runPromise(
    program(
      [headers, refund, row("original", -4, { date: "2026-09-29", nominal: -20, benefit: -16 })],
      fetchFn,
    ),
  );
  const body = await second.json();
  assert.equal(body.provisional, 0);
  assert.equal(body.processed, 0);
  assert.equal(body.duplicateImports, 1);
  assert.equal(transactions.size, 1);
  assert.deepEqual(transactions.get(id), corrected);
  assert.deepEqual(methods, ["GET", "POST", "GET", "POST"]);
});
