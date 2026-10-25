import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyMovements } from "../src/domain/movement-classification.ts";
import { parseSatispayExport } from "../src/infrastructure/satispay-export-reader.ts";
import { buildPreparedImport } from "../src/infrastructure/build-prepared-import.ts";
import { previewSatispay } from "../src/infrastructure/preview-rows.ts";

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
const readExport = (rows) => {
  const parsed = parseSatispayExport(rows);
  assert.equal(parsed._tag, "Export");
  return parsed.satispayExport;
};
const classified = (rows) => classifyMovements(readExport(rows));
const byId = (rows, id) => {
  const found = classified(rows).movements.find((item) => {
    const identifier = item.movement.satispayMovementIdentifier;
    return "value" in identifier && identifier.value === id;
  });
  assert.ok(found, id);
  return found;
};
const walletCents = (item) =>
  item._tag === "ImportCandidate"
    ? item.walletAmount
    : item._tag === "ProvisionalTransaction"
      ? item.provisionalWalletAmount
      : 0;

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
  const audit = classified(sample);
  assert.equal(audit.refundsAdjusted, 2);
  assert.equal(audit.refundsUnresolved, 0);
  assert.equal(walletCents(byId(sample, "refund-a")), 423);
  assert.equal(walletCents(byId(sample, "refund-b")), 300);
  assert.deepEqual(audit.balanceCheck, {
    status: "ok",
    expectedChangeMilliunits: 100000,
    calculatedChangeMilliunits: 100000,
    discrepancyMilliunits: 0,
  });
  const prepared = buildPreparedImport(sample, "2026-08-18");
  assert.equal(prepared.candidates.find((x) => x.satispayId === "refund-a").amountMilliunits, 4230);
  assert.equal(prepared.candidates.find((x) => x.satispayId === "refund-b").amountMilliunits, 3000);
  assert.equal(prepared.refundsAdjusted, 2);
  assert.equal(prepared.balanceCheck.status, "ok");
  const preview = previewSatispay(sample);
  assert.equal(preview.refundsAdjusted, 2);
  assert.equal(preview.balanceCheck.discrepancyMilliunits, 0);
  assert.equal(preview.requiresReview, 0);
});
test("missing merchant original imports the reported refund provisionally", () => {
  const data = [headers, row(date(28), "Cafe", 20.23, "🔄 Rimborso", 20.23, null, 100, "refund")];
  const refund = byId(data, "refund");
  assert.equal(classified(data).refundsUnresolved, 1);
  assert.equal(refund._tag, "ProvisionalTransaction");
  assert.equal(refund.reason, "refund_purchase_not_in_export");
  assert.equal(refund.provisionalWalletAmount, 2023);
  const preview = previewSatispay(data);
  assert.equal(preview.requiresReview, 1);
  const prepared = buildPreparedImport(data, "2026-08-01");
  assert.equal(prepared.counts.rejected, 0);
  assert.equal(prepared.counts.provisional, 1);
  assert.equal(prepared.candidates.length, 1);
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
  const refund = byId(rows, "refund");
  assert.equal(refund._tag, "ProvisionalTransaction");
  assert.equal(refund.reason, "ambiguous_refund_purchase");
  assert.equal(refund.provisionalWalletAmount, 2023);
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
    const prepared = buildPreparedImport(rows, "2026-08-01");
    const refund = prepared.candidates.find((candidate) => candidate.satispayId === "refund");
    assert.equal(refund.amountMilliunits, 20000);
    assert.equal(refund.reviewReason, reason);
    assert.equal(prepared.counts.provisional, 1);
    assert.equal(prepared.counts.rejected, 0);
    // Provisional values must not make the balance audit look verified.
    assert.equal(prepared.balanceCheck.status, "unavailable");
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
    const refund = byId(rows, "refund");
    const actualReason = refund._tag === "ProvisionalTransaction" ? refund.reason : undefined;
    assert.equal(actualReason, reviewReason);
    assert.equal(walletCents(refund), reviewReason ? 2000 : 400);
  }
});
test("a 10,000-row export with repeated merchant amounts retains every ambiguous refund for review", () => {
  const rows = [headers];
  for (let index = 0; index < 5000; index++) {
    rows.push(row(date(28), "Cafe", 20, "🔄 Rimborso", 20, null, null, `refund-${index}`));
    rows.push(row(date(27), "Cafe", -20, "🏬 a un Negozio", -4, -16, null, `purchase-${index}`));
  }
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.candidates.length, 10_000);
  assert.equal(prepared.counts.provisional, 5000);
  assert.equal(prepared.reviewIssues.ambiguous_refund_purchase, 5000);
  assert.equal(prepared.counts.rejected, 0);
});
test("a full voucher refund leads to a zero wallet amount and is skipped", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 16, "🔄 Rimborso", 16, null, 100, "refund"),
    row(date(27), "Cafe", -16, "🏬 a un Negozio", null, -16, 100, "original"),
  ];
  assert.equal(byId(rows, "refund")._tag, "SkippedMovement");
  assert.equal(walletCents(byId(rows, "refund")), 0);
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.candidates.length, 0);
  assert.equal(prepared.counts.withoutAvailability, 2);
});
test("two refunds, one purchase: the later refund stays provisional", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 20, "🔄 Rimborso", 20, null, 140, "refund-later"),
    row(date(27), "Cafe", 20, "🔄 Rimborso", 20, null, 120, "refund-earlier"),
    row(date(26), "Cafe", -20, "🏬 a un Negozio", -20, null, 100, "purchase"),
  ];
  const audit = classified(rows);
  assert.equal(byId(rows, "refund-earlier")._tag, "ImportCandidate");
  assert.equal(walletCents(byId(rows, "refund-earlier")), 2000);
  const laterRefund = byId(rows, "refund-later");
  assert.equal(laterRefund._tag, "ProvisionalTransaction");
  assert.equal(laterRefund.reason, "refund_exceeds_remaining_amount");
  assert.equal(laterRefund.provisionalWalletAmount, 2000);
  assert.equal(audit.refundsUnresolved, 1);
  assert.equal(audit.refundsAdjusted, 0);
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.counts.provisional, 1);
  assert.equal(prepared.reviewIssues.refund_exceeds_remaining_amount, 1);
  const earlier = prepared.candidates.find(
    (candidate) => candidate.satispayId === "refund-earlier",
  );
  const later = prepared.candidates.find((candidate) => candidate.satispayId === "refund-later");
  assert.equal(earlier.amountMilliunits, 20000);
  assert.equal(earlier.reviewReason, undefined);
  assert.equal(later.amountMilliunits, 20000);
  assert.equal(later.reviewReason, "refund_exceeds_remaining_amount");
  assert.match(later.memo, /remaining wallet amount/);
  assert.equal(prepared.balanceCheck.status, "unavailable");
});
test("a partial refund of a wallet-funded purchase matches", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 5, "🔄 Rimborso", 5, null, 105, "refund"),
    row(date(27), "Cafe", -20, "🏬 a un Negozio", -20, null, 100, "purchase"),
  ];
  const audit = classified(rows);
  assert.equal(audit.refundsUnresolved, 0);
  assert.equal(audit.refundsAdjusted, 0);
  assert.equal(byId(rows, "refund")._tag, "ImportCandidate");
  assert.equal(walletCents(byId(rows, "refund")), 500);
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.counts.provisional, 0);
  assert.equal(
    prepared.candidates.find((candidate) => candidate.satispayId === "refund").amountMilliunits,
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
  const audit = classified(rows);
  assert.equal(audit.refundsUnresolved, 0);
  assert.equal(byId(rows, "refund-b")._tag, "ImportCandidate");
  assert.equal(walletCents(byId(rows, "refund-b")), 1200);
  assert.equal(byId(rows, "refund-a")._tag, "ImportCandidate");
  assert.equal(walletCents(byId(rows, "refund-a")), 800);
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.counts.provisional, 0);
  assert.equal(
    prepared.candidates.find((candidate) => candidate.satispayId === "refund-a").amountMilliunits,
    8000,
  );
  assert.equal(
    prepared.candidates.find((candidate) => candidate.satispayId === "refund-b").amountMilliunits,
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
  const audit = classified(rows);
  assert.equal(byId(rows, "refund-fit")._tag, "ImportCandidate");
  assert.equal(walletCents(byId(rows, "refund-fit")), 1500);
  const over = byId(rows, "refund-over");
  assert.equal(over._tag, "ProvisionalTransaction");
  assert.equal(over.reason, "refund_exceeds_remaining_amount");
  assert.equal(over.provisionalWalletAmount, 1000);
  assert.equal(audit.refundsUnresolved, 1);
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.counts.provisional, 1);
  assert.equal(
    prepared.candidates.find((candidate) => candidate.satispayId === "refund-fit").amountMilliunits,
    15000,
  );
  assert.equal(
    prepared.candidates.find((candidate) => candidate.satispayId === "refund-over").reviewReason,
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
  const audit = classified(rows);
  assert.equal(byId(rows, "refund-earlier")._tag, "ImportCandidate");
  assert.equal(walletCents(byId(rows, "refund-earlier")), 423);
  const laterRefund = byId(rows, "refund-later");
  assert.equal(laterRefund._tag, "ProvisionalTransaction");
  assert.equal(laterRefund.reason, "refund_exceeds_remaining_amount");
  assert.equal(laterRefund.provisionalWalletAmount, 2023);
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
  const partial = byId(rows, "refund-partial");
  assert.equal(partial._tag, "ProvisionalTransaction");
  assert.equal(partial.reason, "partial_refund_split_unknown");
  assert.equal(partial.provisionalWalletAmount, 500);
  assert.equal(byId(rows, "refund-full")._tag, "ImportCandidate");
  assert.equal(walletCents(byId(rows, "refund-full")), 400);
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.counts.provisional, 1);
  assert.match(
    prepared.candidates.find((candidate) => candidate.satispayId === "refund-partial").memo,
    /cash and benefit split/,
  );
  assert.equal(
    prepared.candidates.find((candidate) => candidate.satispayId === "refund-full")
      .amountMilliunits,
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
  const refund = byId(rows, "refund");
  assert.equal(refund._tag, "ProvisionalTransaction");
  assert.equal(refund.reason, "ambiguous_refund_purchase");
  assert.equal(refund.provisionalWalletAmount, 1000);
});
test("a partial refund matches the only purchase large enough to absorb it", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 10, "🔄 Rimborso", 10, null, 130, "refund"),
    row(date(27), "Cafe", -20, "🏬 a un Negozio", -20, null, 120, "purchase-large"),
    row(date(26), "Cafe", -5, "🏬 a un Negozio", -5, null, 140, "purchase-small"),
  ];
  const refund = byId(rows, "refund");
  assert.equal(refund._tag, "ImportCandidate");
  assert.equal(refund.walletAmount, 1000);
});
test("a partial refund of a benefit-only purchase restores no wallet amount", () => {
  const rows = [
    headers,
    row(date(28), "Cafe", 6, "🔄 Rimborso", 6, null, 100, "refund"),
    row(date(27), "Cafe", -16, "🏬 a un Negozio", null, -16, 100, "purchase"),
  ];
  const refund = byId(rows, "refund");
  assert.equal(refund._tag, "SkippedMovement");
  assert.equal(walletCents(refund), 0);
  const prepared = buildPreparedImport(rows, "2026-08-01");
  assert.equal(prepared.candidates.length, 0);
  assert.equal(prepared.counts.withoutAvailability, 2);
});
test("non-refund unknown types remain importable; input IDs stay stable", () => {
  const rows = [headers, row(date(28), "-", -12.5, "Altro", -12.5, null, 90, "unknown")];
  const p = buildPreparedImport(rows, "2026-08-01");
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
  const check = classified(data).balanceCheck;
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
  const check = classified(data).balanceCheck;
  assert.equal(check.status, "mismatch");
  assert.equal(check.discrepancyMilliunits, 30000);
  const p = buildPreparedImport(data, "2026-08-01");
  assert.equal(p.counts.rejected, 0);
});
