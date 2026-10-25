import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { importPrepared } from "../src/application/import-prepared.ts";
import { YnabGateway, YnabGatewayError } from "../src/application/ynab-gateway.ts";
import { appConfigLayer } from "../src/infrastructure/app-config.ts";

const env = {
  YNAB_TOKEN: "synthetic-ynab",
  YNAB_PLAN_ID: "plan",
  YNAB_ACCOUNT_ID: "wallet",
  YNAB_WRITE_ENABLED: "true",
};
const openAccount = {
  id: "wallet",
  name: "Satispay",
  onBudget: true,
  closed: false,
  deleted: false,
};

const movement = (id, options = {}) => ({
  satispayMovementIdentifier: { _tag: "Unique", value: id },
  date: { _tag: "Valid", calendarDate: options.date ?? "2026-10-18", instantMs: 0 },
  nominalAmount: { _tag: "Amount", cents: -100 },
  reportedWalletAmount: { _tag: "Amount", cents: -100 },
  mealVoucherAmount: { _tag: "Absent" },
  flexBenefitAmount: { _tag: "Absent" },
  walletBalance: { _tag: "Absent" },
  satispayApproval: "approved",
  kind: options.kind ?? "other",
  typeLabel: options.typeLabel ?? "Altro",
  name: options.name ?? id,
  description: options.description ?? "Synthetic description",
});
const candidate = (id, options = {}) => ({
  _tag: "ImportCandidate",
  movement: movement(id, options),
  walletAmount: -100,
  amountMilliunits: options.milliunits ?? -1000,
});
const provisional = (id, reason, options = {}) => ({
  _tag: "ProvisionalTransaction",
  movement: movement(id, options),
  provisionalWalletAmount: 975,
  amountMilliunits: options.milliunits ?? 9750,
  reason,
});
const skipped = (id) => ({
  _tag: "SkippedMovement",
  movement: movement(id),
  reason: "outside_import_period",
});
const rejected = (id) => ({
  _tag: "RejectedMovement",
  movement: movement(id),
  reason: "not_approved",
});
const preparedImport = (movements) => ({
  movements,
  importCutoff: "2026-10-01",
  refundsAdjusted: 0,
  refundsUnresolved: 0,
  balanceCheck: { status: "unavailable", reason: "insufficient_balance_snapshots" },
  totals: { _tag: "Exact", inflowMilliunits: 0, outflowMilliunits: 0, netMilliunits: 0 },
});
const numbered = (count, make) =>
  Array.from({ length: count }, (_, index) => make(String(index).padStart(5, "0")));

const run = (movements, gateway = {}, config = env) => {
  const calls = { listAccounts: 0, readAccount: 0, createImportBatch: 0 };
  const batches = [];
  const service = {
    listAccounts: () => {
      calls.listAccounts++;
      return Effect.die("import does not list accounts");
    },
    readAccount: () => {
      calls.readAccount++;
      return gateway.readAccount ? gateway.readAccount() : Effect.succeed(openAccount);
    },
    createImportBatch: (input) => {
      calls.createImportBatch++;
      batches.push(input.transactions);
      return gateway.createImportBatch
        ? gateway.createImportBatch(input)
        : Effect.succeed({
            transactionIds: input.transactions.map((transaction) => transaction.importId),
            duplicateImportIds: [],
          });
    },
  };
  const program = importPrepared(preparedImport(movements)).pipe(
    Effect.provideService(YnabGateway, service),
    Effect.provide(appConfigLayer(config)),
  );
  return { calls, batches, program };
};

test("disabled writes create no YNAB calls", async () => {
  const { calls, program } = run([candidate("only")], {}, {});
  const error = await Effect.runPromise(program.pipe(Effect.flip));
  assert.equal(error._tag, "ImportWritesDisabledError");
  assert.match(error.message, /disabled/);
  assert.deepEqual(calls, { listAccounts: 0, readAccount: 0, createImportBatch: 0 });
});

test("more than 10,000 import candidates fail before the gateway is used", async () => {
  const { calls, program } = run(numbered(10_001, candidate));
  const error = await Effect.runPromise(program.pipe(Effect.flip));
  assert.equal(error._tag, "ImportCandidateLimitError");
  assert.match(error.message, /10,000/);
  assert.deepEqual(calls, { listAccounts: 0, readAccount: 0, createImportBatch: 0 });
});

test("skipped and rejected movements do not count toward the candidate limit", async () => {
  const { calls, batches, program } = run([
    ...numbered(10_001, skipped),
    ...numbered(10_001, rejected),
    candidate("only"),
  ]);
  const outcome = await Effect.runPromise(program);
  assert.equal(outcome.confirmed, 1);
  assert.equal(outcome.unattempted, 0);
  assert.equal(calls.readAccount, 1);
  assert.equal(calls.listAccounts, 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].payee, "only");
});

test("the wallet account must be an active on-budget account named Satispay", async () => {
  const cases = [
    [{ ...openAccount, id: "other" }, "WrongId"],
    [{ ...openAccount, name: "Revolut" }, "WrongName"],
    [{ ...openAccount, name: "SATISPAY wallet" }, undefined],
    [{ ...openAccount, onBudget: false }, "OffBudget"],
    [{ ...openAccount, closed: true }, "Closed"],
    [{ ...openAccount, deleted: true }, "Deleted"],
  ];
  for (const [account, reason] of cases) {
    const { calls, program } = run([candidate("only")], {
      readAccount: () => Effect.succeed(account),
    });
    if (reason) {
      const error = await Effect.runPromise(program.pipe(Effect.flip));
      assert.equal(error._tag, "ImportTargetAccountError", reason);
      assert.equal(error.reason, reason);
      assert.match(error.message, /Satispay/);
      assert.equal(calls.createImportBatch, 0);
    } else {
      const outcome = await Effect.runPromise(program);
      assert.equal(outcome.confirmed, 1);
    }
    assert.equal(calls.listAccounts, 0);
    assert.equal(calls.readAccount, 1);
  }
});

test("an unreadable account payload is a target-account failure and is not submitted", async () => {
  const { calls, program } = run([candidate("only")], {
    readAccount: () =>
      Effect.fail(new YnabGatewayError({ operation: "readAccount", reason: { _tag: "Contract" } })),
  });
  const error = await Effect.runPromise(program.pipe(Effect.flip));
  assert.equal(error._tag, "ImportTargetAccountError");
  assert.equal(error.reason, "Malformed");
  assert.equal(calls.createImportBatch, 0);
});

test("a failed account read is not an import batch", async () => {
  const { calls, program } = run([candidate("only")], {
    readAccount: () =>
      Effect.fail(new YnabGatewayError({ operation: "readAccount", reason: { _tag: "Network" } })),
  });
  const error = await Effect.runPromise(program.pipe(Effect.flip));
  assert.equal(error._tag, "YnabGatewayError");
  assert.equal(error.reason._tag, "Network");
  assert.equal(calls.createImportBatch, 0);
});

test("candidates are submitted in sequential batches of 500", async () => {
  let active = 0;
  const sizes = [];
  const firstPayee = [];
  const { calls, program } = run(numbered(1_001, candidate), {
    createImportBatch: (batch) =>
      Effect.promise(async () => {
        assert.equal(active, 0);
        active++;
        await Promise.resolve();
        sizes.push(batch.transactions.length);
        firstPayee.push(batch.transactions[0].payee);
        active--;
        return {
          transactionIds: batch.transactions.map((transaction) => transaction.importId),
          duplicateImportIds: batch.transactions
            .slice(0, 5)
            .map((transaction) => transaction.importId),
        };
      }),
  });
  const outcome = await Effect.runPromise(program);
  assert.deepEqual(sizes, [500, 500, 1]);
  assert.deepEqual(firstPayee, ["00000", "00500", "01000"]);
  assert.equal(calls.createImportBatch, 3);
  assert.equal(calls.readAccount, 1);
  assert.deepEqual(outcome, {
    confirmed: 1001,
    duplicate: 11,
    failed: 0,
    uncertain: 0,
    unattempted: 0,
    ynabReportedTransactionIds: 1001,
  });
});

test("10,000 candidates are accepted in 20 batches", async () => {
  const sizes = [];
  const { program } = run(numbered(10_000, candidate), {
    createImportBatch: (batch) => {
      sizes.push(batch.transactions.length);
      return Effect.succeed({ transactionIds: [], duplicateImportIds: [] });
    },
  });
  const outcome = await Effect.runPromise(program);
  assert.deepEqual(sizes, Array(20).fill(500));
  assert.equal(outcome.confirmed, 10_000);
  assert.equal(outcome.unattempted, 0);
});

test("the import stops at the first failed batch and keeps confirmed progress", async () => {
  for (const [reason, uncertain] of [
    [{ _tag: "Network" }, true],
    [{ _tag: "Timeout" }, true],
    [{ _tag: "Response" }, true],
    [{ _tag: "Contract" }, true],
    [{ _tag: "Http", status: 503 }, true],
    [{ _tag: "Http", status: 500 }, true],
    [{ _tag: "Http", status: 400 }, false],
    [{ _tag: "Http", status: 429 }, false],
    [{ _tag: "Encode" }, false],
  ]) {
    let writes = 0;
    const { program } = run(numbered(1_001, candidate), {
      createImportBatch: (batch) => {
        writes++;
        if (writes === 2) {
          return Effect.fail(new YnabGatewayError({ operation: "createImportBatch", reason }));
        }
        return Effect.succeed({
          transactionIds: batch.transactions.map((transaction) => transaction.importId),
          duplicateImportIds: batch.transactions
            .slice(0, 10)
            .map((transaction) => transaction.importId),
        });
      },
    });
    const error = await Effect.runPromise(program.pipe(Effect.flip));
    assert.equal(error._tag, "ImportBatchError", reason._tag);
    assert.equal(error.failure._tag, uncertain ? "Uncertain" : "Rejected");
    assert.equal(error.failure.reason, reason._tag);
    if (reason._tag === "Http") assert.equal(error.failure.status, reason.status);
    assert.equal(writes, 2);
    assert.equal(error.outcome.confirmed, 500);
    assert.equal(error.outcome.duplicate, 10);
    assert.equal(error.outcome.ynabReportedTransactionIds, 500);
    assert.equal(error.outcome.uncertain, uncertain ? 500 : 0);
    assert.equal(error.outcome.failed, uncertain ? 0 : 500);
    assert.equal(error.outcome.unattempted, 1);
    if (uncertain) assert.match(error.message, /verify|Check import status/i);
    assert.equal(error.message.includes("private"), false);
  }
});

test("too many duplicate import ids are an uncertain batch and stop the import", async () => {
  let writes = 0;
  const { program } = run(numbered(1_001, candidate), {
    createImportBatch: (batch) => {
      writes++;
      if (writes === 2) {
        return Effect.succeed({
          transactionIds: [],
          duplicateImportIds: Array(501).fill("duplicate"),
        });
      }
      return Effect.succeed({
        transactionIds: batch.transactions.map((transaction) => transaction.importId),
        duplicateImportIds: [],
      });
    },
  });
  const error = await Effect.runPromise(program.pipe(Effect.flip));
  assert.equal(error._tag, "ImportBatchError");
  assert.deepEqual(error.failure, { _tag: "Uncertain", reason: "DuplicateCount" });
  assert.equal(writes, 2);
  assert.equal(error.outcome.confirmed, 500);
  assert.equal(error.outcome.duplicate, 0);
  assert.equal(error.outcome.uncertain, 500);
  assert.equal(error.outcome.failed, 0);
  assert.equal(error.outcome.unattempted, 1);
  assert.match(error.message, /verify/);
});

test("a provisional transaction is flagged for review and a normal one is cleared", async () => {
  let submitted;
  const { calls, program } = run(
    [
      provisional("refund", "refund_purchase_not_in_export", {
        name: "Synthetic Market",
        description: "Source description ".repeat(40),
        milliunits: 9750,
        kind: "merchantRefund",
        date: "2026-10-16",
      }),
      candidate("purchase", {
        name: "Synthetic Shop",
        description: "Synthetic description",
        milliunits: -12340,
        kind: "merchantPurchase",
        typeLabel: "🏬 a un Negozio",
        date: "2026-10-18",
      }),
      candidate("points", {
        name: "Ignored",
        description: "",
        milliunits: 2990,
        kind: "cashback",
        date: "2026-10-12",
      }),
    ],
    {
      createImportBatch: (batch) => {
        submitted = batch.transactions;
        return Effect.succeed({
          transactionIds: batch.transactions.map((transaction) => transaction.importId),
          duplicateImportIds: [],
        });
      },
    },
  );
  const outcome = await Effect.runPromise(program);
  assert.equal(outcome.confirmed, 3);
  assert.equal(calls.listAccounts, 0);
  assert.equal(submitted.length, 3);
  const refund = submitted.find((transaction) => transaction.amountMilliunits > 9000);
  assert.equal(refund.payee, "Synthetic Market");
  assert.equal(refund.cleared, "uncleared");
  assert.equal(refund.approved, false);
  assert.equal(refund.flagColor, "orange");
  assert.match(refund.memo, /original purchase is absent/);
  assert.match(refund.memo, /provisional wallet amount/);
  assert.match(refund.memo, /orange flag/);
  assert.match(refund.memo, /Source description/);
  assert.ok(refund.memo.length <= 500);
  const purchase = submitted.find((transaction) => transaction.amountMilliunits < 0);
  assert.equal(purchase.payee, "Synthetic Shop");
  assert.equal(purchase.memo, "Synthetic description");
  assert.equal(purchase.cleared, "cleared");
  assert.equal(purchase.approved, false);
  assert.equal(purchase.flagColor, undefined);
  const cashback = submitted.find((transaction) => transaction.payee === "Satispay Cashback");
  assert.equal(cashback.amountMilliunits, 2990);
  assert.equal(cashback.memo, undefined);
  assert.equal(cashback.cleared, "cleared");
  assert.equal(cashback.approved, false);
  assert.equal(cashback.flagColor, undefined);
});

test("an empty prepared import validates the wallet account and creates no batch", async () => {
  const { calls, program } = run([]);
  const outcome = await Effect.runPromise(program);
  assert.deepEqual(outcome, {
    confirmed: 0,
    duplicate: 0,
    failed: 0,
    uncertain: 0,
    unattempted: 0,
    ynabReportedTransactionIds: 0,
  });
  assert.equal(calls.readAccount, 1);
  assert.equal(calls.createImportBatch, 0);
  assert.equal(calls.listAccounts, 0);
});
