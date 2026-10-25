import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyMovements } from "../src/domain/movement-classification.ts";

const at = (day, hour = 12) =>
  Date.parse(`2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`);
const amount = (cents) => ({ _tag: "Amount", cents });
const absent = { _tag: "Absent" };

function movement(overrides = {}) {
  const day = overrides.day ?? 28;
  const hour = overrides.hour ?? 12;
  const id = overrides.id ?? "movement";
  const { day: _day, hour: _hour, id: _id, identifier, nominal, wallet, ...rest } = overrides;
  return {
    satispayMovementIdentifier: identifier ?? { _tag: "Unique", value: id },
    date: {
      _tag: "Valid",
      calendarDate: `2026-08-${String(day).padStart(2, "0")}`,
      instantMs: at(day, hour),
    },
    nominalAmount: amount(nominal ?? -1000),
    reportedWalletAmount: amount(wallet ?? nominal ?? -1000),
    mealVoucherAmount: absent,
    flexBenefitAmount: absent,
    walletBalance: absent,
    satispayApproval: "approved",
    kind: "merchantPurchase",
    typeLabel: "purchase",
    name: "Cafe",
    description: id,
    ...rest,
  };
}

function classify(movements, options = {}) {
  return classifyMovements(
    { movements, includesWalletBalance: options.includesWalletBalance ?? false },
    options.importCutoff ?? null,
  );
}

const find = (classification, id) =>
  classification.movements.find((item) => item.movement.description === id);

test("classification separates import candidates, skipped movements and rejected movements", () => {
  const classification = classify([
    movement({ id: "out", nominal: -400, wallet: -400, kind: "other", typeLabel: "Altro" }),
    movement({ id: "benefit", nominal: -800, reportedWalletAmount: absent }),
    movement({ id: "zero", nominal: 0, wallet: 0, kind: "other" }),
    movement({
      id: "dup",
      identifier: { _tag: "Duplicate", value: "dup" },
      nominal: -100,
      wallet: -100,
      kind: "other",
    }),
    movement({
      id: "missing",
      identifier: { _tag: "Missing" },
      nominal: -100,
      wallet: -100,
      kind: "other",
    }),
    movement({
      id: "numeric",
      identifier: { _tag: "NotText" },
      nominal: -100,
      wallet: -100,
      kind: "other",
    }),
    movement({
      id: "date",
      date: { _tag: "Invalid" },
      nominal: -100,
      wallet: -100,
      kind: "other",
    }),
    movement({
      id: "status",
      satispayApproval: "notApproved",
      nominal: -100,
      wallet: -100,
      kind: "other",
    }),
    movement({
      id: "amount",
      reportedWalletAmount: { _tag: "Unreadable" },
      kind: "other",
    }),
  ]);
  assert.equal(find(classification, "out")._tag, "ImportCandidate");
  assert.equal(find(classification, "out").walletAmount, -400);
  assert.equal(find(classification, "benefit")._tag, "SkippedMovement");
  assert.equal(find(classification, "benefit").reason, "no_availability_movement");
  assert.equal(find(classification, "zero").reason, "zero_availability_movement");
  for (const id of ["dup", "missing", "numeric"]) {
    const rejected = find(classification, id);
    assert.equal(rejected._tag, "RejectedMovement");
    assert.equal(rejected.reason, "missing_or_duplicate_id");
  }
  assert.equal(find(classification, "date").reason, "invalid_date");
  assert.equal(find(classification, "status").reason, "not_approved");
  assert.equal(find(classification, "amount").reason, "invalid_wallet_amount");
});

test("a merchant refund restores only the original purchase wallet amount", () => {
  const classification = classify([
    movement({
      id: "refund",
      day: 28,
      kind: "merchantRefund",
      nominal: 2023,
      wallet: 2023,
      name: "Cafe A",
    }),
    movement({
      id: "purchase",
      day: 27,
      nominal: -2023,
      wallet: -423,
      mealVoucherAmount: amount(-1600),
      name: "CAFE   A",
    }),
  ]);
  const refund = find(classification, "refund");
  const purchase = find(classification, "purchase");
  assert.equal(refund._tag, "ImportCandidate");
  assert.equal(refund.walletAmount, 423);
  assert.equal(purchase._tag, "ImportCandidate");
  assert.equal(purchase.walletAmount, -423);
  assert.equal(classification.refundsAdjusted, 1);
  assert.equal(classification.refundsUnresolved, 0);
});

test("an earlier refund consumes remaining wallet amount and a later refund stays provisional", () => {
  const classification = classify([
    movement({ id: "later", day: 28, kind: "merchantRefund", nominal: 1000, wallet: 1000 }),
    movement({ id: "earlier", day: 27, kind: "merchantRefund", nominal: 1500, wallet: 1500 }),
    movement({ id: "purchase", day: 26, nominal: -2000, wallet: -2000 }),
  ]);
  const earlier = find(classification, "earlier");
  const later = find(classification, "later");
  assert.equal(earlier._tag, "ImportCandidate");
  assert.equal(earlier.walletAmount, 1500);
  assert.equal(later._tag, "ProvisionalTransaction");
  assert.equal(later.reason, "refund_exceeds_remaining_amount");
  assert.equal(later.provisionalWalletAmount, 1000);
  assert.equal(classification.refundsUnresolved, 1);
  assert.equal(classification.refundsAdjusted, 0);
});

test("partial wallet refunds share one purchase's remaining wallet amount", () => {
  const classification = classify([
    movement({ id: "second", day: 28, kind: "merchantRefund", nominal: 1200, wallet: 1200 }),
    movement({ id: "first", day: 27, kind: "merchantRefund", nominal: 800, wallet: 800 }),
    movement({ id: "purchase", day: 26, nominal: -2000, wallet: -2000 }),
  ]);
  assert.equal(find(classification, "first").walletAmount, 800);
  assert.equal(find(classification, "second").walletAmount, 1200);
  assert.equal(classification.refundsUnresolved, 0);
  assert.equal(classification.refundsAdjusted, 0);
});

test("a partial refund of a mixed purchase stays provisional and leaves the remaining wallet amount", () => {
  const classification = classify([
    movement({ id: "full", day: 28, kind: "merchantRefund", nominal: 2000, wallet: 2000 }),
    movement({ id: "partial", day: 27, kind: "merchantRefund", nominal: 500, wallet: 500 }),
    movement({
      id: "purchase",
      day: 26,
      nominal: -2000,
      wallet: -400,
      mealVoucherAmount: amount(-1600),
    }),
  ]);
  const partial = find(classification, "partial");
  const full = find(classification, "full");
  assert.equal(partial._tag, "ProvisionalTransaction");
  assert.equal(partial.reason, "partial_refund_split_unknown");
  assert.equal(partial.provisionalWalletAmount, 500);
  assert.equal(full._tag, "ImportCandidate");
  assert.equal(full.walletAmount, 400);
  assert.equal(classification.refundsAdjusted, 1);
  assert.equal(classification.refundsUnresolved, 1);
});

test("a benefit-only refund restores no wallet amount and both movements are skipped", () => {
  const classification = classify([
    movement({ id: "refund", day: 28, kind: "merchantRefund", nominal: 1600, wallet: 1600 }),
    movement({
      id: "purchase",
      day: 27,
      nominal: -1600,
      reportedWalletAmount: absent,
      mealVoucherAmount: amount(-1600),
    }),
  ]);
  assert.equal(find(classification, "refund").reason, "zero_availability_movement");
  assert.equal(find(classification, "purchase").reason, "no_availability_movement");
  assert.equal(classification.refundsAdjusted, 1);
  assert.equal(classification.refundsUnresolved, 0);
});

test("ambiguous and missing original purchases keep the reported wallet amount", () => {
  const ambiguous = classify([
    movement({ id: "refund", day: 28, kind: "merchantRefund", nominal: 2000, wallet: 2000 }),
    movement({
      id: "purchase-a",
      day: 27,
      nominal: -2000,
      wallet: -400,
      mealVoucherAmount: amount(-1600),
    }),
    movement({
      id: "purchase-b",
      day: 26,
      nominal: -2000,
      wallet: -1200,
      mealVoucherAmount: amount(-800),
    }),
  ]);
  const ambiguousRefund = find(ambiguous, "refund");
  assert.equal(ambiguousRefund._tag, "ProvisionalTransaction");
  assert.equal(ambiguousRefund.reason, "ambiguous_refund_purchase");
  assert.equal(ambiguousRefund.provisionalWalletAmount, 2000);

  const missing = classify([
    movement({ id: "refund", kind: "merchantRefund", nominal: 2023, wallet: 2023 }),
  ]);
  const missingRefund = find(missing, "refund");
  assert.equal(missingRefund._tag, "ProvisionalTransaction");
  assert.equal(missingRefund.reason, "refund_purchase_not_in_export");
  assert.equal(missingRefund.provisionalWalletAmount, 2023);
});

test("refund matching keeps the inclusive 90-day window", () => {
  const refundTime = Date.parse("2026-10-18T12:00:00.000Z");
  const oldest = refundTime - 90 * 24 * 60 * 60 * 1000;
  const refund = movement({
    id: "refund",
    kind: "merchantRefund",
    nominal: 2000,
    wallet: 2000,
    date: { _tag: "Valid", calendarDate: "2026-10-18", instantMs: refundTime },
  });
  const purchaseAt = (time) =>
    movement({
      id: "purchase",
      nominal: -2000,
      wallet: -400,
      mealVoucherAmount: amount(-1600),
      date: {
        _tag: "Valid",
        calendarDate: new Date(time).toISOString().slice(0, 10),
        instantMs: time,
      },
    });
  assert.equal(find(classify([refund, purchaseAt(oldest)]), "refund").walletAmount, 400);
  assert.equal(find(classify([refund, purchaseAt(refundTime)]), "refund").walletAmount, 400);
  assert.equal(
    find(classify([refund, purchaseAt(oldest - 1)]), "refund").reason,
    "refund_purchase_not_in_export",
  );
  assert.equal(
    find(classify([refund, purchaseAt(refundTime + 1)]), "refund").reason,
    "refund_purchase_not_in_export",
  );
});

test("an unapproved merchant refund is rejected and a non-positive refund amount is rejected", () => {
  const unapproved = classify([
    movement({
      id: "refund",
      kind: "merchantRefund",
      nominal: 2000,
      wallet: 2000,
      satispayApproval: "notApproved",
    }),
  ]);
  assert.equal(find(unapproved, "refund")._tag, "RejectedMovement");
  assert.equal(find(unapproved, "refund").reason, "not_approved");
  assert.equal(unapproved.refundsUnresolved, 1);

  const nonPositive = classify([
    movement({ id: "refund", kind: "merchantRefund", nominal: 1000, wallet: 0 }),
  ]);
  assert.equal(find(nonPositive, "refund").reason, "invalid_refund_amount");
  assert.equal(nonPositive.refundsUnresolved, 1);
});

test("the wallet balance check compares snapshot change with wallet amounts in the interval", () => {
  const rows = (recentBalance) => [
    movement({
      id: "recent",
      day: 28,
      kind: "other",
      nominal: 3000,
      wallet: 3000,
      walletBalance: amount(recentBalance),
    }),
    movement({
      id: "oldest",
      day: 26,
      kind: "other",
      nominal: -1000,
      wallet: -1000,
      walletBalance: amount(10000),
    }),
  ];
  assert.deepEqual(classify(rows(13000), { includesWalletBalance: true }).balanceCheck, {
    status: "ok",
    expectedChangeMilliunits: 30000,
    calculatedChangeMilliunits: 30000,
    discrepancyMilliunits: 0,
  });
  const mismatch = classify(rows(14000), { includesWalletBalance: true }).balanceCheck;
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.discrepancyMilliunits, 10000);

  const provisional = classify(
    [
      movement({
        id: "recent",
        day: 28,
        kind: "other",
        nominal: 1000,
        wallet: 1000,
        walletBalance: amount(11000),
      }),
      movement({
        id: "refund",
        day: 27,
        kind: "merchantRefund",
        nominal: 2000,
        wallet: 2000,
        walletBalance: amount(10000),
      }),
      movement({
        id: "oldest",
        day: 26,
        kind: "other",
        nominal: -1000,
        wallet: -1000,
        walletBalance: amount(8000),
      }),
    ],
    { includesWalletBalance: true },
  );
  assert.equal(find(provisional, "refund")._tag, "ProvisionalTransaction");
  assert.deepEqual(provisional.balanceCheck, {
    status: "unavailable",
    reason: "unresolved_or_invalid_wallet_amount",
  });
  assert.deepEqual(classify(rows(13000)).balanceCheck, {
    status: "unavailable",
    reason: "insufficient_balance_snapshots",
  });
});

test("without an import cutoff every in-range movement is classified, and a cutoff only skips earlier ones", () => {
  const movements = [
    movement({ id: "refund", day: 28, kind: "merchantRefund", nominal: 2023, wallet: 2023 }),
    movement({
      id: "purchase",
      day: 10,
      nominal: -2023,
      wallet: -423,
      mealVoucherAmount: amount(-1600),
    }),
  ];
  const wholeExport = classify(movements);
  assert.equal(find(wholeExport, "purchase")._tag, "ImportCandidate");
  assert.equal(find(wholeExport, "refund").walletAmount, 423);

  const prepared = classify(movements, { importCutoff: "2026-08-20" });
  assert.equal(find(prepared, "purchase")._tag, "SkippedMovement");
  assert.equal(find(prepared, "purchase").reason, "outside_import_period");
  assert.equal(find(prepared, "refund")._tag, "ImportCandidate");
  assert.equal(find(prepared, "refund").walletAmount, 423);
});

test("wallet totals overflow as data when included amounts cannot become milliunits", () => {
  const classification = classify([
    movement({ id: "a", kind: "other", nominal: 5e14, wallet: 5e14 }),
    movement({ id: "b", kind: "other", nominal: 5e14, wallet: 5e14 }),
  ]);
  assert.equal(find(classification, "a")._tag, "ImportCandidate");
  assert.equal(find(classification, "b")._tag, "ImportCandidate");
  assert.equal(classification.totals._tag, "Overflow");
});
