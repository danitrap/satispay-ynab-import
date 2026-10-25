import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSheet } from "read-excel-file/universal";
import { Effect } from "effect";
import { handleRequestEffect } from "../src/http/handle-request.ts";
import { requestLiveLayer } from "../src/main.ts";
import { createRealisticWorkbook } from "../scripts/generate-satispay-fixture.mjs";

const workbook = readFileSync(new URL("./fixtures/satispay-realistic.xlsx", import.meta.url));
const CUTOFF = "2026-10-01";
const account = { id: "wallet", name: "Satispay", on_budget: true, closed: false };

function arrayBuffer(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

async function importId(satispayId) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("satispay-transaction-id-v1:" + satispayId),
  );
  const hex = [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
  return "SPS:" + hex.slice(0, 32);
}

const run = (
  mode,
  fetchFn = async () => {
    throw new Error("Unexpected network request");
  },
) => {
  const env = {
    UPLOAD_TOKEN: "upload-secret",
    YNAB_IMPORT_FROM: CUTOFF,
    YNAB_TOKEN: "test",
    YNAB_PLAN_ID: "plan",
    YNAB_ACCOUNT_ID: "wallet",
    YNAB_WRITE_ENABLED: "true",
  };
  const request = new Request(`https://local.invalid/${mode}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer upload-secret",
      "X-Confirm-Import": "yes",
      "Content-Type": "application/octet-stream",
    },
    body: workbook,
  });
  return Effect.runPromise(
    handleRequestEffect(request).pipe(Effect.provide(requestLiveLayer(env, fetchFn))),
  );
};

const privateValues = [
  "Caffè Sintetico",
  "Panificio Sintetico",
  "Banca Sintetica",
  "syn-cashback",
  "syn-refund-cafe",
  "Accredito punti",
  "Rimborso pranzo",
  "Cornetto",
];

test("the committed workbook matches the generator", async () => {
  const generated = await readSheet(arrayBuffer(createRealisticWorkbook()));
  const committed = await readSheet(arrayBuffer(workbook));
  assert.deepEqual(generated, committed);
  assert.equal(committed.length, 15);
  assert.equal(committed[0][0], "Data");
  assert.equal(committed[0][6], "Disponibilità");
  assert.ok(committed[0][10].startsWith("ID ("));
  assert.ok(committed[1][0] instanceof Date);
  assert.equal(typeof committed[1][3], "string");
  assert.equal(committed[1][3].includes(","), true);
});

test("inspect reads datetime cells and Italian amount text without transaction details", async () => {
  const response = await run("inspect");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.rowCount, 14);
  assert.equal(body.analysis.dateCellTypes.date, 14);
  assert.equal(body.analysis.dateCellTypes.text, 0);
  assert.equal(body.analysis.monetaryColumns.Importo.textCells, 14);
  assert.equal(body.analysis.monetaryColumns.Importo.unparseable, 0);
  assert.equal(body.analysis.monetaryColumns.Importo.negative, 10);
  assert.equal(body.analysis.monetaryColumns.Importo.positive, 4);
  assert.equal(body.analysis.monetaryColumns["Buoni Pasto"].negative, 3);
  assert.equal(body.analysis.monetaryColumns.FlexBen.negative, 2);
  assert.equal(body.analysis.identifiers.distinct, 14);
  assert.equal(body.analysis.identifiers.numericCells, 0);
  assert.equal(body.analysis.types.counts.find((entry) => entry.value === "🔄 Rimborso").count, 1);
  assert.equal(
    body.analysis.statuses.counts.find((entry) => entry.value === "❌ Rifiutato").count,
    1,
  );
  const serialized = JSON.stringify(body);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
});

test("preview classifies the whole synthetic export, including the adjusted refund", async () => {
  const response = await run("preview");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "preview-only");
  assert.equal(body.rowCount, 14);
  assert.deepEqual(
    [body.eligible, body.skipped, body.requiresReview, body.provisional],
    [11, 2, 1, 0],
  );
  assert.equal(body.byReason.wallet_outflow, 7);
  assert.equal(body.byReason.wallet_inflow, 4);
  assert.equal(body.byReason.no_availability_movement, 2);
  assert.equal(body.byReason.not_approved, 1);
  assert.equal(body.outflowEur, "37.63");
  assert.equal(body.inflowEur, "1392.18");
  assert.equal(body.netEur, "1354.55");
  assert.equal(body.outflowMilliunits, 37630);
  assert.equal(body.inflowMilliunits, 1392180);
  assert.equal(body.netMilliunits, 1354550);
  assert.equal(body.refundsAdjusted, 1);
  assert.equal(body.refundsUnresolved, 0);
  assert.deepEqual(body.balanceCheck, {
    status: "ok",
    expectedChangeMilliunits: 1194560,
    calculatedChangeMilliunits: 1194560,
    discrepancyMilliunits: 0,
  });
  const serialized = JSON.stringify(body);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
});

test("prepare applies the cutoff and keeps historical purchases out of the import", async () => {
  const response = await run("prepare");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "prepare-only");
  assert.equal(body.fromDate, CUTOFF);
  assert.equal(body.exported, 14);
  assert.equal(body.olderThanStart, 3);
  assert.equal(body.withoutAvailability, 2);
  assert.equal(body.rejected, 1);
  assert.equal(body.provisional, 0);
  assert.equal(body.eligible, 8);
  assert.equal(body.requiresReview, 1);
  assert.deepEqual(body.issues, { not_approved: 1 });
  assert.deepEqual(body.reviewIssues, {});
  assert.equal(body.outflowMilliunits, 30900);
  assert.equal(body.inflowMilliunits, 1242180);
  assert.equal(body.netMilliunits, 1211280);
  assert.equal(body.refundsAdjusted, 1);
  assert.equal(body.refundsUnresolved, 0);
  assert.equal(body.balanceCheck.status, "ok");
  assert.equal(body.balanceCheck.discrepancyMilliunits, 0);
  assert.equal(body.imported, 0);
  const serialized = JSON.stringify(body);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
});

const expectedTransactions = [
  ["syn-after-midnight", "2026-10-01", -1800, "Panificio Sintetico", "Cornetto"],
  ["syn-mixed", "2026-10-04", -10000, "Market Misto", "Spesa mista"],
  ["syn-cashback", "2026-10-05", 3390, "Satispay Cashback", "Accredito punti"],
  ["syn-p2p", "2026-10-06", -15000, "Persona Sintetica", "Compleanno"],
  ["syn-refund-cafe", "2026-10-07", 4230, "Caffè Sintetico", "Rimborso pranzo"],
  ["syn-morning-edge", "2026-10-09", -1100, "Chiosco Sintetico", "Giornale"],
  ["syn-iban", "2026-10-10", 1234560, "Banca Sintetica", "Bonifico in entrata"],
  ["syn-unknown", "2026-10-11", -3000, "Satispay — Altro", "Movimento senza nome"],
];

test("import posts wallet amounts, stable import IDs, dates, payees and memos", async () => {
  const submitted = [];
  const response = await run("import", async (_url, init) => {
    if (init.method === "GET") return Response.json({ data: { account } });
    const transactions = JSON.parse(init.body).transactions;
    submitted.push(...transactions);
    return Response.json({
      data: {
        transaction_ids: transactions.map((transaction) => transaction.import_id),
        duplicate_import_ids: [],
      },
    });
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "import-completed");
  assert.equal(body.processed, 8);
  assert.equal(body.imported, 8);
  assert.equal(body.duplicateImports, 0);
  assert.equal(body.eligible, 8);
  assert.equal(body.rejected, 1);
  assert.equal(body.olderThanStart, 3);
  assert.equal(body.provisional, 0);
  assert.equal(body.refundsAdjusted, 1);
  assert.equal(submitted.length, expectedTransactions.length);
  for (const [index, [id, date, amount, payee, memo]] of expectedTransactions.entries()) {
    const transaction = submitted[index];
    assert.equal(transaction.date, date, id);
    assert.equal(transaction.amount, amount, id);
    assert.equal(transaction.payee_name, payee, id);
    assert.equal(transaction.memo, memo, id);
    assert.equal(transaction.account_id, "wallet");
    assert.equal(transaction.cleared, "cleared");
    assert.equal(transaction.approved, false);
    assert.equal(transaction.flag_color, undefined);
    assert.equal(transaction.import_id, await importId(id));
    assert.equal(transaction.import_id.length, 36);
    assert.equal(transaction.import_id.startsWith("SPS:"), true);
    assert.equal(transaction.import_id.includes(id), false);
  }
  const posted = JSON.stringify(submitted);
  for (const excluded of [
    "syn-rejected",
    "syn-meal-only",
    "syn-flex-only",
    "syn-late-september",
    "syn-purchase-cafe",
    "syn-cutoff-topup",
    "Negozio Rifiutato",
    "provisional wallet amount",
  ]) {
    assert.equal(posted.includes(excluded), false, excluded);
  }
  const serialized = JSON.stringify(body);
  for (const value of [...privateValues, submitted[0].import_id]) {
    assert.equal(serialized.includes(value), false);
  }
});

test("calendar days near midnight stay on the spreadsheet date in every timezone", () => {
  for (const tz of [
    "UTC",
    "Europe/Rome",
    "America/New_York",
    "Pacific/Honolulu",
    "Pacific/Kiritimati",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "tests/realistic-export-tz-probe.mjs"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, `${tz}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    const byId = Object.fromEntries(body.candidates.map((candidate) => [candidate.id, candidate]));
    assert.equal(body.olderThanStart, 3, tz);
    assert.equal(byId["syn-after-midnight"].date, "2026-10-01", tz);
    assert.equal(byId["syn-after-midnight"].amount, -1800, tz);
    assert.equal(byId["syn-morning-edge"].date, "2026-10-09", tz);
    assert.equal(byId["syn-late-september"], undefined, tz);
    assert.equal(byId["syn-cutoff-topup"], undefined, tz);
  }
});
