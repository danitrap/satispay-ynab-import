import { test } from "node:test";
import { strict as assert } from "node:assert";
import { analyzeLedger } from "../src/ledger.ts";
import { buildImportPlan } from "../src/import-plan.ts";
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
  "FlexBen",
  "Disponibilità dopo la transazione",
  "ID (Comunicalo all'Assistenza Clienti in caso di problemi)",
];
const date = (day, hour = 12) =>
  new Date(`2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`);
const row = (d, name, nominal, type, available, meal, balance, id, flex = null) => [
  d,
  name,
  "",
  nominal,
  type,
  "✅ Approvato",
  available,
  meal,
  flex,
  balance,
  id,
];

const sample = [
  headers,
  row(date(28, 18), "Cafe A", 20.23, "🔄 Rimborso", 20.23, null, 200, "refund-a"),
  row(date(28, 17), "Cafe A", -20.23, "🏬 a un Negozio", -4.23, -16, 195.77, "purchase-a"),
  row(date(20, 18), "Cafe B", 19, "🔄 Rimborso", 19, null, 200, "refund-b"),
  row(date(20, 17), "Cafe B", -19, "🏬 a un Negozio", -3, -16, 197, "purchase-b"),
  row(date(19), "Bank", 100, "🏦 Dalla Banca", 100, null, 200, "bank"),
  row(date(18), "Shop", -5, "🏬 a un Negozio", -5, null, 100, "old"),
];
test("mixed meal-voucher refunds match original purchase and only restore wallet amount", () => {
  const audit = analyzeLedger(sample);
  assert.equal(audit.refundsAdjusted, 2);
  assert.equal(audit.refundsUnresolved, 0);
  assert.equal(audit.resolved[0].amountCents, 423);
  assert.equal(audit.resolved[2].amountCents, 300);
  assert.deepEqual(audit.balanceCheck, {
    status: "ok",
    expectedChangeMilliunits: 100000,
    calculatedChangeMilliunits: 100000,
    discrepancyMilliunits: 0,
  });
  const plan = buildImportPlan(sample, "2026-08-18");
  assert.equal(plan.candidates.find((x) => x.satispayId === "refund-a").amountMilliunits, 4230);
  assert.equal(plan.candidates.find((x) => x.satispayId === "refund-b").amountMilliunits, 3000);
  assert.equal(plan.refundsAdjusted, 2);
  assert.equal(plan.balanceCheck.status, "ok");
  const preview = previewSatispay(sample);
  assert.equal(preview.refundsAdjusted, 2);
  assert.equal(preview.balanceCheck.discrepancyMilliunits, 0);
  assert.equal(preview.requiresReview, 0);
});
test("missing merchant original imports the reported refund provisionally", () => {
  const data = [headers, row(date(28), "Cafe", 20.23, "🔄 Rimborso", 20.23, null, 100, "refund")];
  const audit = analyzeLedger(data);
  assert.equal(audit.refundsUnresolved, 1);
  assert.equal(audit.resolved[0].reviewReason, "refund_purchase_not_in_export");
  assert.equal(audit.resolved[0].amountCents, 2023);
  const preview = previewSatispay(data);
  assert.equal(preview.requiresReview, 1);
  const plan = buildImportPlan(data, "2026-08-01");
  assert.equal(plan.counts.rejected, 0);
  assert.equal(plan.counts.provisional, 1);
  assert.equal(plan.candidates.length, 1);
  assert.equal(preview.eligible, 1);
  assert.equal(preview.provisional, 1);
  assert.equal(preview.inflowMilliunits, 20230);
});
test("ambiguous same-merchant equal-amount purchases are not guessed", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 20.23, "🔄 Rimborso", 20.23, null, 200, "refund"),
    row(date(28, 11), "Cafe", -20.23, "🏬 a un Negozio", -4.23, -16, 195.77, "purchase-1"),
    row(date(27), "Cafe", -20.23, "🏬 a un Negozio", -12.23, -8, 200, "purchase-2"),
  ];
  const r = analyzeLedger(rows);
  assert.equal(r.resolved[0].reviewReason, "ambiguous_refund_purchase");
  assert.equal(r.resolved[0].amountCents, 2023);
});
test("inconsistent funding and unverifiable nominal amounts retain a provisional wallet amount", () => {
  for (const [nominal, benefit, reason] of [
    [20, -10, "refund_purchase_funding_mismatch"],
    ["invalid", -16, "invalid_refund_details"],
  ]) {
    const rows = [
      headers,
      row(date(28), "Cafe", nominal, "🔄 Rimborso", 20, null, 120, "refund"),
      row(date(27), "Cafe", -20, "🏬 a un Negozio", -4, benefit, 100, "purchase"),
    ];
    const plan = buildImportPlan(rows, "2026-08-01");
    const refund = plan.candidates.find((candidate) => candidate.satispayId === "refund");
    assert.equal(refund.amountMilliunits, 20000);
    assert.equal(refund.reviewReason, reason);
    assert.equal(plan.counts.provisional, 1);
    assert.equal(plan.counts.rejected, 0);
    // Provisional values must not make the balance audit look verified.
    assert.equal(plan.balanceCheck.status, "unavailable");
    assert.equal(previewSatispay(rows).requiresReview, 1);
  }
});
test("indexed refund matching retains inclusive 90-day boundaries and merchant normalization", () => {
  const refundTime = Date.parse("2026-10-18T12:00:00Z");
  const oldest = refundTime - 90 * 24 * 60 * 60 * 1000;
  for (const [purchaseTime, reviewReason] of [
    [oldest, undefined],
    [refundTime, undefined],
    [oldest - 1, "refund_purchase_not_in_export"],
    [refundTime + 1, "refund_purchase_not_in_export"],
  ]) {
    const rows = [
      headers,
      row(new Date(refundTime), "Cafe A", 20, "🔄 Rimborso", 20, null, 100, "refund"),
      row(new Date(purchaseTime), "  CAFE   A ", -20, "🏬 a un Negozio", -4, -16, 96, "purchase"),
    ];
    const resolution = analyzeLedger(rows).resolved[0];
    assert.equal(resolution.reviewReason, reviewReason);
    assert.equal(resolution.amountCents, reviewReason ? 2000 : 400);
  }
});
test("a 10,000-row export with repeated merchant amounts retains every ambiguous refund for review", () => {
  const rows = [headers];
  for (let index = 0; index < 5000; index++) {
    rows.push(row(date(28), "Cafe", 20, "🔄 Rimborso", 20, null, null, `refund-${index}`));
    rows.push(row(date(27), "Cafe", -20, "🏬 a un Negozio", -4, -16, null, `purchase-${index}`));
  }
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.candidates.length, 10_000);
  assert.equal(plan.counts.provisional, 5000);
  assert.equal(plan.reviewIssues.ambiguous_refund_purchase, 5000);
  assert.equal(plan.counts.rejected, 0);
});
test("a full voucher refund leads to a zero wallet amount and is skipped", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 16, "🔄 Rimborso", 16, null, 100, "refund"),
    row(date(27), "Cafe", -16, "🏬 a un Negozio", null, -16, 100, "original"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[0].amountCents, 0);
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.counts.withoutAvailability, 2);
});
test("two refunds, one purchase: the later refund stays provisional", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 20, "🔄 Rimborso", 20, null, 140, "refund-later"),
    row(date(27), "Cafe", 20, "🔄 Rimborso", 20, null, 120, "refund-earlier"),
    row(date(26), "Cafe", -20, "🏬 a un Negozio", -20, null, 100, "purchase"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[1].reviewReason, undefined);
  assert.equal(audit.resolved[1].amountCents, 2000);
  assert.equal(audit.resolved[0].reviewReason, "refund_exceeds_remaining_amount");
  assert.equal(audit.resolved[0].amountCents, 2000);
  assert.equal(audit.refundsUnresolved, 1);
  assert.equal(audit.refundsAdjusted, 0);
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.counts.provisional, 1);
  assert.equal(plan.reviewIssues.refund_exceeds_remaining_amount, 1);
  const earlier = plan.candidates.find((candidate) => candidate.satispayId === "refund-earlier");
  const later = plan.candidates.find((candidate) => candidate.satispayId === "refund-later");
  assert.equal(earlier.amountMilliunits, 20000);
  assert.equal(earlier.reviewReason, undefined);
  assert.equal(later.amountMilliunits, 20000);
  assert.equal(later.reviewReason, "refund_exceeds_remaining_amount");
  assert.match(later.memo, /remaining wallet amount/);
  assert.equal(plan.balanceCheck.status, "unavailable");
});
test("a partial refund of a wallet-funded purchase matches", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 5, "🔄 Rimborso", 5, null, 105, "refund"),
    row(date(27), "Cafe", -20, "🏬 a un Negozio", -20, null, 100, "purchase"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.refundsUnresolved, 0);
  assert.equal(audit.refundsAdjusted, 0);
  assert.equal(audit.resolved[0].reviewReason, undefined);
  assert.equal(audit.resolved[0].amountCents, 500);
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.counts.provisional, 0);
  assert.equal(
    plan.candidates.find((candidate) => candidate.satispayId === "refund").amountMilliunits,
    5000,
  );
});
test("multiple partial refunds summing to the purchase all match", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 12, "🔄 Rimborso", 12, null, 120, "refund-b"),
    row(date(27), "Cafe", 8, "🔄 Rimborso", 8, null, 108, "refund-a"),
    row(date(26), "Cafe", -20, "🏬 a un Negozio", -20, null, 100, "purchase"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.refundsUnresolved, 0);
  assert.equal(audit.resolved[0].amountCents, 1200);
  assert.equal(audit.resolved[0].reviewReason, undefined);
  assert.equal(audit.resolved[1].amountCents, 800);
  assert.equal(audit.resolved[1].reviewReason, undefined);
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.counts.provisional, 0);
  assert.equal(
    plan.candidates.find((candidate) => candidate.satispayId === "refund-a").amountMilliunits,
    8000,
  );
  assert.equal(
    plan.candidates.find((candidate) => candidate.satispayId === "refund-b").amountMilliunits,
    12000,
  );
});
test("a refund exceeding the remaining wallet amount stays provisional", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 10, "🔄 Rimborso", 10, null, 125, "refund-over"),
    row(date(27), "Cafe", 15, "🔄 Rimborso", 15, null, 115, "refund-fit"),
    row(date(26), "Cafe", -20, "🏬 a un Negozio", -20, null, 100, "purchase"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[1].reviewReason, undefined);
  assert.equal(audit.resolved[1].amountCents, 1500);
  assert.equal(audit.resolved[0].reviewReason, "refund_exceeds_remaining_amount");
  assert.equal(audit.resolved[0].amountCents, 1000);
  assert.equal(audit.refundsUnresolved, 1);
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.counts.provisional, 1);
  assert.equal(
    plan.candidates.find((candidate) => candidate.satispayId === "refund-fit").amountMilliunits,
    15000,
  );
  assert.equal(
    plan.candidates.find((candidate) => candidate.satispayId === "refund-over").reviewReason,
    "refund_exceeds_remaining_amount",
  );
});
test("a second full refund does not reuse a mixed purchase", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 20.23, "🔄 Rimborso", 20.23, null, 200, "refund-later"),
    row(date(27), "Cafe", 20.23, "🔄 Rimborso", 20.23, null, 195.77, "refund-earlier"),
    row(date(26), "Cafe", -20.23, "🏬 a un Negozio", -4.23, -16, 191.54, "purchase"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[1].amountCents, 423);
  assert.equal(audit.resolved[1].adjusted, true);
  assert.equal(audit.resolved[1].reviewReason, undefined);
  assert.equal(audit.resolved[0].reviewReason, "refund_exceeds_remaining_amount");
  assert.equal(audit.resolved[0].amountCents, 2023);
  assert.equal(audit.refundsAdjusted, 1);
  assert.equal(audit.refundsUnresolved, 1);
});
test("a partial refund of a mixed purchase stays provisional and does not consume it", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 20, "🔄 Rimborso", 20, null, 120, "refund-full"),
    row(date(27), "Cafe", 5, "🔄 Rimborso", 5, null, 105, "refund-partial"),
    row(date(26), "Cafe", -20, "🏬 a un Negozio", -4, -16, 100, "purchase"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[1].reviewReason, "partial_refund_split_unknown");
  assert.equal(audit.resolved[1].amountCents, 500);
  assert.equal(audit.resolved[0].reviewReason, undefined);
  assert.equal(audit.resolved[0].amountCents, 400);
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.counts.provisional, 1);
  assert.match(
    plan.candidates.find((candidate) => candidate.satispayId === "refund-partial").memo,
    /cash and benefit split/,
  );
  assert.equal(
    plan.candidates.find((candidate) => candidate.satispayId === "refund-full").amountMilliunits,
    4000,
  );
});
test("a partial refund is ambiguous when two purchases could absorb it", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 10, "🔄 Rimborso", 10, null, 130, "refund"),
    row(date(27), "Cafe", -20, "🏬 a un Negozio", -20, null, 120, "purchase-a"),
    row(date(26), "Cafe", -15, "🏬 a un Negozio", -15, null, 140, "purchase-b"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[0].reviewReason, "ambiguous_refund_purchase");
  assert.equal(audit.resolved[0].amountCents, 1000);
});
test("a partial refund matches the only purchase large enough to absorb it", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 10, "🔄 Rimborso", 10, null, 130, "refund"),
    row(date(27), "Cafe", -20, "🏬 a un Negozio", -20, null, 120, "purchase-large"),
    row(date(26), "Cafe", -5, "🏬 a un Negozio", -5, null, 140, "purchase-small"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[0].reviewReason, undefined);
  assert.equal(audit.resolved[0].amountCents, 1000);
});
test("a partial refund of a benefit-only purchase restores no wallet amount", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 6, "🔄 Rimborso", 6, null, 100, "refund"),
    row(date(27), "Cafe", -16, "🏬 a un Negozio", null, -16, 100, "purchase"),
  ];
  const audit = analyzeLedger(rows);
  assert.equal(audit.resolved[0].amountCents, 0);
  assert.equal(audit.resolved[0].reviewReason, undefined);
  const plan = buildImportPlan(rows, "2026-08-01");
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.counts.withoutAvailability, 2);
});
test("non-refund unknown types remain importable; input IDs stay stable", () => {
  const rows = [headers, row(date(28), "-", -12.5, "Altro", -12.5, null, 90, "unknown")];
  const p = buildImportPlan(rows, "2026-08-01");
  assert.equal(p.candidates.length, 1);
  assert.equal(p.candidates[0].amountMilliunits, -12500);
  assert.equal(p.candidates[0].satispayId, "unknown");
});
test("global balance audit tolerates out-of-order intermediate card settlements", () => {
  const data = [
    headers,
    row(date(28), "Bank", 30, "🏦 Dalla Banca", 30, null, 120, "one"),
    row(date(27), "Card", -10, "Carta ••2156", -10, null, 105, "two"),
    row(date(26), "Old", -1, "Altro", -1, null, 100, "three"),
  ];
  const check = analyzeLedger(data).balanceCheck;
  assert.equal(check.status, "ok");
  assert.equal(check.discrepancyMilliunits, 0);
});
test("balance audit detects a discrepancy without blocking normal transactions", () => {
  const data = [
    headers,
    row(date(28), "Bank", 30, "🏦 Dalla Banca", 30, null, 150, "one"),
    row(date(27), "Card", -10, "Carta ••2156", -10, null, 105, "two"),
    row(date(26), "Old", -1, "Altro", -1, null, 100, "three"),
  ];
  const check = analyzeLedger(data).balanceCheck;
  assert.equal(check.status, "mismatch");
  assert.equal(check.discrepancyMilliunits, 30000);
  const p = buildImportPlan(data, "2026-08-01");
  assert.equal(p.counts.rejected, 0);
});
