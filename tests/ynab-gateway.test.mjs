import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { YnabGateway } from "../src/application/ynab-gateway.ts";
import { requestLiveLayer } from "../src/main.ts";

const env = {
  YNAB_TOKEN: "synthetic-ynab",
  YNAB_PLAN_ID: "plan",
  YNAB_ACCOUNT_ID: "wallet",
  YNAB_WRITE_ENABLED: "true",
};
const transaction = {
  accountId: "wallet",
  date: "2026-10-18",
  amountMilliunits: -12340,
  payee: "Synthetic Shop",
  memo: "Synthetic description",
  cleared: "uncleared",
  approved: false,
  flagColor: "orange",
  importId: "SPS:test",
};
const clearedTransaction = {
  accountId: "wallet",
  date: "2026-10-12",
  amountMilliunits: 40000,
  payee: "Synthetic Bank",
  cleared: "cleared",
  approved: false,
  importId: "SPS:topup",
};

const gateway = (fetchFn, config = env) =>
  Effect.gen(function* () {
    return yield* YnabGateway;
  }).pipe(Effect.provide(requestLiveLayer(config, fetchFn)));

const clocked = (program) => Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));

test("the gateway lists, reads and creates one batch", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (String(url).endsWith("/accounts")) {
      return Response.json({
        data: {
          accounts: [
            { id: "sat", name: "Satispay", on_budget: true, closed: false },
            { id: "rev", name: "Revolut", on_budget: false, closed: true, deleted: true },
          ],
        },
      });
    }
    if (init.method === "GET") {
      return Response.json({
        data: { account: { id: "wallet", name: "My Satispay", on_budget: true, closed: false } },
      });
    }
    return Response.json({
      data: { transaction_ids: ["created", "matched"], duplicate_import_ids: ["SPS:test"] },
    });
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const ynab = yield* gateway(fetchFn);
      assert.deepEqual(Object.keys(ynab).sort(), [
        "createImportBatch",
        "listAccounts",
        "readAccount",
      ]);
      const accounts = yield* ynab.listAccounts("plan");
      const account = yield* ynab.readAccount("plan", "wallet");
      const created = yield* ynab.createImportBatch({
        planId: "plan",
        transactions: [transaction, clearedTransaction],
      });
      return { accounts, account, created };
    }),
  );
  assert.deepEqual(result.accounts, [
    { id: "sat", name: "Satispay", onBudget: true, closed: false, deleted: false },
    { id: "rev", name: "Revolut", onBudget: false, closed: true, deleted: true },
  ]);
  assert.deepEqual(result.account, {
    id: "wallet",
    name: "My Satispay",
    onBudget: true,
    closed: false,
    deleted: false,
  });
  assert.deepEqual(result.created, {
    transactionIds: ["created", "matched"],
    duplicateImportIds: ["SPS:test"],
  });
  assert.match(calls[0].url, /\/v1\/plans\/plan\/accounts$/);
  assert.match(calls[1].url, /\/v1\/plans\/plan\/accounts\/wallet$/);
  assert.match(calls[2].url, /\/v1\/plans\/plan\/transactions$/);
  assert.equal(calls[2].method, "POST");
  assert.deepEqual(calls[2].body, {
    transactions: [
      {
        account_id: "wallet",
        date: "2026-10-18",
        amount: -12340,
        payee_name: "Synthetic Shop",
        memo: "Synthetic description",
        cleared: "uncleared",
        approved: false,
        flag_color: "orange",
        import_id: "SPS:test",
      },
      {
        account_id: "wallet",
        date: "2026-10-12",
        amount: 40000,
        payee_name: "Synthetic Bank",
        cleared: "cleared",
        approved: false,
        import_id: "SPS:topup",
      },
    ],
  });
});

test("a transaction POST is attempted once and transport failures stay on the gateway error", async () => {
  const cases = [
    {
      response: () => {
        throw new Error("private transport details");
      },
      reason: { _tag: "Network" },
    },
    {
      response: () => new Response("private server details", { status: 503 }),
      reason: { _tag: "Http", status: 503 },
    },
    {
      response: () => new Response("private invalid json", { status: 200 }),
      reason: { _tag: "Response" },
    },
    {
      response: () => Response.json({ data: {} }),
      reason: { _tag: "Contract" },
    },
    {
      response: () => new Response("rate limited", { status: 429 }),
      reason: { _tag: "Http", status: 429 },
    },
  ];
  for (const entry of cases) {
    let writes = 0;
    const fetchFn = async (_url, init) => {
      assert.equal(init.method, "POST");
      writes++;
      return entry.response();
    };
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const ynab = yield* gateway(fetchFn);
        return yield* ynab.createImportBatch({
          planId: "plan",
          transactions: [clearedTransaction],
        });
      }).pipe(Effect.flip),
    );
    assert.equal(error._tag, "YnabGatewayError");
    assert.equal(error.operation, "createImportBatch");
    assert.deepEqual(error.reason, entry.reason);
    assert.equal(writes, 1);
    assert.equal(error.message.includes("private"), false);
  }
});

test(
  "reading an account retries a 503 and does not retry a malformed payload",
  { timeout: 5000 },
  async () => {
    let unavailable = 0;
    await clocked(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            const ynab = yield* gateway(async () => {
              unavailable++;
              return new Response("", { status: 503 });
            });
            return yield* ynab.listAccounts("plan");
          }).pipe(Effect.flip),
        );
        yield* TestClock.adjust("200 millis");
        yield* TestClock.adjust("400 millis");
        const error = yield* Fiber.join(fiber);
        assert.equal(error._tag, "YnabGatewayError");
        assert.deepEqual(error.reason, { _tag: "Http", status: 503 });
        assert.equal(unavailable, 3);
        assert.equal((yield* Clock.currentTimeMillis) > 0, true);
      }),
    );

    let malformed = 0;
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const ynab = yield* gateway(async () => {
          malformed++;
          return Response.json({
            data: { account: { id: "wallet", name: "Satispay", on_budget: "yes", closed: false } },
          });
        });
        return yield* ynab.readAccount("plan", "wallet");
      }).pipe(Effect.flip),
    );
    assert.equal(error._tag, "YnabGatewayError");
    assert.equal(error.operation, "readAccount");
    assert.equal(error.reason._tag, "Contract");
    assert.equal(malformed, 1);
  },
);

test("a POST timeout aborts the single attempt", { timeout: 5000 }, async () => {
  let writes = 0;
  let aborted = false;
  let started;
  const postStarted = new Promise((resolve) => {
    started = resolve;
  });
  const fetchFn = async (_url, init) => {
    writes++;
    started();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      ),
    );
  };
  await clocked(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const ynab = yield* gateway(fetchFn);
          return yield* ynab.createImportBatch({
            planId: "plan",
            transactions: [clearedTransaction],
          });
        }).pipe(Effect.flip),
      );
      yield* Effect.promise(() => postStarted);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "YnabGatewayError");
      assert.deepEqual(error.reason, { _tag: "Timeout" });
      assert.equal(writes, 1);
      assert.equal(aborted, true);
    }),
  );
});

test("a missing YNAB token fails before any request", async () => {
  let calls = 0;
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const ynab = yield* gateway(
        async () => {
          calls++;
          throw new Error("should not fetch");
        },
        { YNAB_WRITE_ENABLED: "false" },
      );
      return yield* ynab.readAccount("plan", "wallet");
    }).pipe(Effect.flip),
  );
  assert.equal(error._tag, "ConfigurationError");
  assert.equal(error.key, "YNAB_TOKEN");
  assert.equal(calls, 0);
});
