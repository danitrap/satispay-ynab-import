import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { importPrepared } from "../src/application/import-prepared.ts";
import { YnabGateway } from "../src/application/ynab-gateway.ts";
import { buildPreparedImport } from "../src/infrastructure/build-prepared-import.ts";
import { handleRequestEffect } from "../src/http/handle-request.ts";
import { appConfigLayer } from "../src/infrastructure/app-config.ts";
import { requestLiveLayer } from "../src/main.ts";
import { importIdentity } from "../src/application/ynab-transaction.ts";
import { WorkbookReader } from "../src/application/workbook-reader.ts";

// Pinned import identities for these synthetic Satispay movement identifiers.
// The literals are today's `SPS:` + SHA-256 values. Recomputing them here would
// hide a change that creates duplicate YNAB transactions. The import use case
// computes them while translating a movement into a YNAB transaction.
const PURCHASE_ID = "synthetic-movement-purchase";
const REFUND_ID = "synthetic-movement-refund";
const TOP_UP_ID = "synthetic-movement-topup";
const PROVISIONAL_ID = "synthetic-movement-provisional";
const ORIGINAL_PURCHASE_ID = "synthetic-movement-original-purchase";

const IMPORT_IDENTITIES = [
  {
    movementId: PURCHASE_ID,
    date: "2026-10-18",
    amount: -12340,
    cleared: "cleared",
    flag: undefined,
    importId: "SPS:a367534de0e503bb8905d51acbc2063f",
  },
  {
    movementId: REFUND_ID,
    date: "2026-10-10",
    amount: 6500,
    cleared: "cleared",
    flag: undefined,
    importId: "SPS:75fcaedc8e3d15b8ef0c673d16614476",
  },
  {
    movementId: TOP_UP_ID,
    date: "2026-10-12",
    amount: 40000,
    cleared: "cleared",
    flag: undefined,
    importId: "SPS:468b3684d7054d0b198ed99738c802b8",
  },
  {
    movementId: PROVISIONAL_ID,
    date: "2026-10-16",
    amount: 9750,
    cleared: "uncleared",
    flag: "orange",
    importId: "SPS:3b0b15b85d2c52639de5544dc244f8e1",
  },
];

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
const movement = (id, date, name, nominal, type, wallet, benefit = null) => [
  date,
  name,
  "Synthetic description",
  nominal,
  type,
  "✅ Approvato",
  wallet,
  id,
  benefit,
];
const rows = [
  headers,
  movement(
    ORIGINAL_PURCHASE_ID,
    "2026-09-20",
    "Synthetic Cafe",
    -20,
    "🏬 a un Negozio",
    -6.5,
    -13.5,
  ),
  movement(REFUND_ID, "2026-10-10", "Synthetic Cafe", 20, "🔄 Rimborso", 20),
  movement(TOP_UP_ID, "2026-10-12", "Synthetic Bank", 40, "🏦 Dalla Banca", 40),
  movement(PROVISIONAL_ID, "2026-10-16", "Synthetic Market", 9.75, "🔄 Rimborso", 9.75),
  movement(PURCHASE_ID, "2026-10-18", "Synthetic Shop", -12.34, "🏬 a un Negozio", -12.34),
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

test("an import keeps today's import identity for purchases, refunds, top-ups and provisional transactions", async () => {
  let submitted;
  const response = await Effect.runPromise(
    handleRequestEffect(
      new Request("https://local.invalid/import", {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-upload", "X-Confirm-Import": "yes" },
        body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      }),
    ).pipe(
      Effect.provideService(WorkbookReader, { read: () => Effect.succeed(rows) }),
      Effect.provide(
        requestLiveLayer(env, async (_url, init) => {
          if (init?.method === "GET") return Response.json({ data: { account } });
          submitted = JSON.parse(init.body).transactions;
          return Response.json({
            data: {
              transaction_ids: submitted.map((transaction) => transaction.import_id),
              duplicate_import_ids: [],
            },
          });
        }),
      ),
    ),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "import-completed");
  assert.equal(body.processed, 4);
  assert.equal(body.provisional, 1);
  assert.equal(body.olderThanStart, 1);
  assert.equal(submitted.length, 4);

  for (const expected of IMPORT_IDENTITIES) {
    const matches = submitted.filter(
      (transaction) =>
        transaction.date === expected.date &&
        transaction.amount === expected.amount &&
        transaction.cleared === expected.cleared &&
        (transaction.flag_color ?? undefined) === expected.flag,
    );
    assert.equal(matches.length, 1, expected.movementId);
    assert.equal(matches[0].import_id, expected.importId, expected.movementId);
  }
});

test("the exported import identity is the pinned SPS value of the Satispay movement identifier", async () => {
  for (const expected of IMPORT_IDENTITIES) {
    assert.equal(
      await Effect.runPromise(importIdentity(expected.movementId)),
      expected.importId,
      expected.movementId,
    );
  }
});

test("the import use case translation keeps the pinned import identity", async () => {
  const prepared = buildPreparedImport(rows, env.YNAB_IMPORT_FROM);
  let submitted;
  const outcome = await Effect.runPromise(
    importPrepared(prepared.preparedImport).pipe(
      Effect.provideService(YnabGateway, {
        listAccounts: () => Effect.die("import does not list accounts"),
        readAccount: () =>
          Effect.succeed({
            id: "wallet",
            name: "Satispay",
            onBudget: true,
            closed: false,
            deleted: false,
          }),
        createImportBatch: (batch) => {
          submitted = batch.transactions;
          return Effect.succeed({
            transactionIds: batch.transactions.map((transaction) => transaction.importId),
            duplicateImportIds: [],
          });
        },
      }),
      Effect.provide(appConfigLayer(env)),
    ),
  );
  assert.equal(outcome.confirmed, 4);
  assert.equal(outcome.duplicate, 0);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.uncertain, 0);
  assert.equal(outcome.unattempted, 0);
  assert.equal(submitted.length, 4);
  for (const expected of IMPORT_IDENTITIES) {
    const matches = submitted.filter(
      (transaction) =>
        transaction.date === expected.date &&
        transaction.amountMilliunits === expected.amount &&
        transaction.cleared === expected.cleared &&
        transaction.approved === false &&
        (transaction.flagColor ?? undefined) === expected.flag,
    );
    assert.equal(matches.length, 1, expected.movementId);
    assert.equal(matches[0].importId, expected.importId, expected.movementId);
  }
});
