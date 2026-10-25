import { test } from "node:test";
import { strict as assert } from "node:assert";
import { previewSatispay } from "../src/infrastructure/preview-rows.ts";

const hdr = [
  "Data",
  "Nome",
  "Descrizione",
  "Importo",
  "Tipo",
  "Stato",
  "Disponibilità",
  "Buoni Pasto",
  "FlexBen",
  "Disponibilità dopo la transazione",
  "ID (Comunicalo all'Assistenza Clienti in caso di problemi)",
];
const day = new Date("2026-10-17T00:00:00.000Z");
test("only moves in Disponibilità and no benefits spending", () => {
  const p = previewSatispay([
    hdr,
    [day, "Shop", "foo", -20, "🏬 a un Negozio", "✅ Approvato", -5, -15, null, 95, "a"],
    [day, "Shop", "meal", -8, "🏬 a un Negozio", "✅ Approvato", null, -8, null, null, "b"],
    [day, "Satispay", "cashback", 3, "🎖️ Punti", "✅ Approvato", 3, null, null, 98, "c"],
    [
      day,
      "Pension",
      "pension",
      -100,
      "al Fondo Pensioni",
      "✅ Approvato",
      null,
      null,
      -100,
      null,
      "d",
    ],
  ]);
  assert.deepEqual([p.eligible, p.skipped, p.requiresReview], [2, 2, 0]);
  assert.equal(p.outflowEur, "5.00");
  assert.equal(p.inflowEur, "3.00");
  assert.equal(p.netEur, "-2.00");
  assert.equal(JSON.stringify(p).includes("Shop"), false);
  assert.equal(JSON.stringify(p).includes('"a"'), false);
});
test("unknown wallet outflows and bank top-ups are included by sign", () => {
  const p = previewSatispay([
    hdr,
    [day, "-", "unknown transaction", -4, "Altro", "✅ Approvato", -4, null, null, 90, "other"],
    [day, "Bank", "recharge", 50, "🏦 Dalla Banca", "✅ Approvato", 50, null, null, 140, "bank"],
  ]);
  assert.equal(p.requiresReview, 0);
  assert.equal(p.eligible, 2);
  assert.equal(p.byReason.wallet_outflow, 1);
  assert.equal(p.byReason.wallet_inflow, 1);
  assert.equal(p.outflowEur, "4.00");
  assert.equal(p.inflowEur, "50.00");
});
test("identical IDs and bad statuses are blocked, zero values skipped", () => {
  const p = previewSatispay([
    hdr,
    [day, "x", "", -1, "🏬 a un Negozio", "✅ Approvato", -1, null, null, 90, "same"],
    [day, "x", "", -1, "🏬 a un Negozio", "✅ Approvato", -1, null, null, 90, "same"],
    [day, "x", "", -1, "🏬 a un Negozio", "In attesa", -1, null, null, 90, "other"],
    [day, "x", "", 0, "🏬 a un Negozio", "✅ Approvato", 0, null, null, 90, "four"],
  ]);
  assert.equal(p.eligible, 0);
  assert.equal(p.requiresReview, 3);
  assert.equal(p.skipped, 1);
  assert.equal(p.byReason.missing_or_duplicate_id, 2);
});

test("formatted amounts are stable and milliunits stay exact", () => {
  const p = previewSatispay([
    hdr,
    [day, "a", "", -70.12, "🏬 a un Negozio", "✅ Approvato", -70.12, null, null, 22, "a"],
    [day, "b", "", -20.11, "🏬 a un Negozio", "✅ Approvato", -20.11, null, null, 2, "b"],
    [day, "c", "", 18.2, "🎖️ Punti", "✅ Approvato", 18.2, null, null, 20, "c"],
  ]);
  assert.equal(p.outflowEur, "90.23");
  assert.equal(p.inflowEur, "18.20");
  assert.equal(p.netEur, "-72.03");
  assert.equal(p.outflowMilliunits, 90230);
  assert.equal(p.inflowMilliunits, 18200);
  assert.equal(p.netMilliunits, -72030);
});
