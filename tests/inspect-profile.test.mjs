import { test } from "node:test";
import { strict as assert } from "node:assert";
import { summarizeSheet } from "../src/infrastructure/satispay-export-reader.ts";

const columns = [
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
const rows = [
  columns,
  ["2026-10-16", "Bar A", "Pranzo", -12.5, "Pagamento", "Completato", -2.5, -10, 0, 30, "txn-1"],
  ["2026-10-17", "Persona B", "Ricarica", 50, "Ricarica", "Completato", 50, 0, 0, 80, "txn-2"],
  ["2026-10-18", "Bar A", "Pranzo", -12.5, "Pagamento", "Completato", -2.5, -10, 0, 67.5, "txn-3"],
  ["2026-10-19", "Altro", "", 0, "Pagamento", "In attesa", 0, 0, 0, 67.5, "txn-1"],
];
test("summarizes Satispay types, statuses, funding and identifier quality", () => {
  const s = summarizeSheet(rows);
  assert.equal(s.rowCount, 4);
  assert.equal(s.analysis.types.counts.find((x) => x.value === "Pagamento").count, 3);
  assert.equal(s.analysis.statuses.counts.find((x) => x.value === "In attesa").count, 1);
  assert.equal(s.analysis.identifiers.present, 4);
  assert.equal(s.analysis.identifiers.distinct, 3);
  assert.equal(s.analysis.identifiers.duplicateRows, 1);
  assert.equal(s.analysis.monetaryColumns.Importo.negative, 2);
  assert.equal(s.analysis.monetaryColumns["Buoni Pasto"].negative, 2);
  assert.equal(s.analysis.monetaryColumns["Disponibilità"].positive, 1);
  assert.equal(JSON.stringify(s).includes("Bar A"), false);
  assert.equal(JSON.stringify(s).includes("txn-1"), false);
  assert.equal(JSON.stringify(s).includes("67.50"), false);
});
test("correctly recognizes localized European monetary amounts", () => {
  const s = summarizeSheet([
    ["Disponibilità", "Importo"],
    ["€ 1.234,56", "-9,90"],
    ["0", "(12,50)"],
    ["", "err"],
  ]);
  assert.equal(s.analysis.monetaryColumns.Importo.negative, 2);
  assert.equal(s.analysis.monetaryColumns.Importo.unparseable, 1);
  assert.equal(s.analysis.monetaryColumns["Disponibilità"].positive, 1);
});
test("reports numeric Excel identifiers as an identity risk", () => {
  const s = summarizeSheet([
    ["Tipo", "ID"],
    ["Pagamento", 12345],
    ["Pagamento", 12345],
    ["Ricarica", null],
  ]);
  assert.equal(s.analysis.identifiers.numericCells, 2);
  assert.equal(s.analysis.identifiers.missing, 1);
  assert.equal(s.analysis.identifiers.duplicateRows, 1);
});
