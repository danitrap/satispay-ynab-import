import { test } from "node:test";
import { strict as assert } from "node:assert";
import { calendarDate } from "../src/domain.ts";
import { classifyMovements } from "../src/domain/movement-classification.ts";
import { prepareImport } from "../src/domain/prepared-import.ts";
import { parseSatispayExport } from "../src/infrastructure/satispay-export-reader.ts";
import { buildPreparedImport } from "../src/prepared-import.ts";
import { previewSatispay } from "../src/preview.ts";

const headers = [
  "Data",
  "Nome",
  "Descrizione",
  "Importo",
  "Tipo",
  "Stato",
  "Disponibilità",
  "Buoni Pasto",
  "ID",
];
const at = (day) => new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`);
const row = (day, name, nominal, type, wallet, benefit, id) => [
  at(day),
  name,
  id,
  nominal,
  type,
  "✅ Approvato",
  wallet,
  benefit,
  id,
];
const rows = [
  headers,
  row(28, "Cafe", 20.23, "🔄 Rimborso", 20.23, null, "refund"),
  row(20, "Cafe", -20.23, "🏬 a un Negozio", -4.23, -16, "purchase"),
  row(10, "Shop", -5, "🏬 a un Negozio", -5, null, "before-cutoff"),
];

test("the same export yields the same classification apart from the import cutoff", () => {
  const parsed = parseSatispayExport(rows);
  assert.equal(parsed._tag, "Export");
  const cutoff = calendarDate("2026-08-15");
  assert.ok(cutoff);
  const previewClassification = classifyMovements(parsed.satispayExport);
  const prepared = prepareImport(parsed.satispayExport, cutoff);
  const built = buildPreparedImport(rows, "2026-08-15");
  const preview = previewSatispay(rows);

  assert.equal(prepared.importCutoff, cutoff);
  assert.deepEqual(built.preparedImport, prepared);
  assert.equal(preview.refundsAdjusted, previewClassification.refundsAdjusted);
  assert.deepEqual(preview.balanceCheck, previewClassification.balanceCheck);
  assert.equal(prepared.refundsAdjusted, previewClassification.refundsAdjusted);
  assert.equal(prepared.refundsUnresolved, previewClassification.refundsUnresolved);
  assert.deepEqual(prepared.balanceCheck, previewClassification.balanceCheck);

  let cutoffSkips = 0;
  for (const [index, withoutCutoff] of previewClassification.movements.entries()) {
    const withCutoff = prepared.movements[index];
    const early =
      withoutCutoff.movement.date._tag === "Valid" &&
      withoutCutoff.movement.date.calendarDate < cutoff;
    if (early) {
      cutoffSkips++;
      assert.equal(withCutoff._tag, "SkippedMovement");
      assert.equal(withCutoff.reason, "outside_import_period");
      assert.notEqual(withoutCutoff._tag, "SkippedMovement");
    } else {
      assert.deepEqual(withCutoff, withoutCutoff);
    }
  }
  assert.equal(cutoffSkips, 1);
  assert.equal(built.counts.olderThanStart, cutoffSkips);
  assert.equal(preview.eligible, 3);
  assert.equal(built.summary.eligible, 2);
  const refund = built.candidates.find((candidate) => candidate.satispayId === "refund");
  const classifiedRefund = prepared.movements.find(
    (item) =>
      item.movement.satispayMovementIdentifier._tag === "Unique" &&
      item.movement.satispayMovementIdentifier.value === "refund",
  );
  assert.equal(classifiedRefund._tag, "ImportCandidate");
  assert.equal(refund.amountMilliunits, classifiedRefund.amountMilliunits);
  assert.equal(refund.amountMilliunits, 4230);
});
