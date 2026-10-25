import {
  centsToMilliunits,
  makeCents,
  makeMilliunits,
  type CalendarDate,
  type Cents,
  type Milliunits,
} from "./primitives.ts";
import type { MovementAmount, SatispayExportRead, SatispayMovement } from "./satispay-movement.ts";

/**
 * Pure movement classification for one Satispay export.
 * Merchant-refund matching sees every movement, including those before an import cutoff.
 * Preview calls this without an import cutoff. Prepared import calls it with one.
 * Nothing here throws or imports Effect.
 */

/** A movement whose essential data or Satispay approval cannot be imported. */
export type RejectionReason =
  | "missing_or_duplicate_id"
  | "invalid_date"
  | "not_approved"
  | "invalid_availability_amount"
  | "invalid_wallet_amount"
  | "invalid_refund_amount";

/** A movement that indicates no cash-wallet change, or sits outside the import cutoff. */
export type SkipReason =
  "outside_import_period" | "no_availability_movement" | "zero_availability_movement";

/** Why a merchant refund's wallet amount cannot be established from the export. */
export type AmbiguityReason =
  | "ambiguous_refund_purchase"
  | "refund_purchase_not_in_export"
  | "refund_purchase_funding_mismatch"
  | "invalid_refund_details"
  | "refund_exceeds_remaining_amount"
  | "partial_refund_split_unknown";

export type ImportCandidate = {
  readonly _tag: "ImportCandidate";
  readonly movement: SatispayMovement;
  readonly walletAmount: Cents;
  readonly amountMilliunits: Milliunits;
};

/** An import candidate whose wallet amount is the reported wallet amount pending review. */
export type ProvisionalTransaction = {
  readonly _tag: "ProvisionalTransaction";
  readonly movement: SatispayMovement;
  readonly provisionalWalletAmount: Cents;
  readonly amountMilliunits: Milliunits;
  readonly reason: AmbiguityReason;
};

export type SkippedMovement = {
  readonly _tag: "SkippedMovement";
  readonly movement: SatispayMovement;
  readonly reason: SkipReason;
};

export type RejectedMovement = {
  readonly _tag: "RejectedMovement";
  readonly movement: SatispayMovement;
  readonly reason: RejectionReason;
};

export type ClassifiedMovement =
  ImportCandidate | ProvisionalTransaction | SkippedMovement | RejectedMovement;

export type WalletBalanceUnavailableReason =
  | "insufficient_balance_snapshots"
  | "export_not_reverse_chronological"
  | "unresolved_or_invalid_wallet_amount"
  | "unsafe_money_range";

export type WalletBalanceCheck =
  | {
      readonly status: "ok" | "mismatch";
      readonly expectedChangeMilliunits: Milliunits;
      readonly calculatedChangeMilliunits: Milliunits;
      readonly discrepancyMilliunits: Milliunits;
    }
  | {
      readonly status: "unavailable";
      readonly reason: WalletBalanceUnavailableReason;
    };

export type WalletTotals =
  | {
      readonly _tag: "Exact";
      readonly inflowMilliunits: Milliunits;
      readonly outflowMilliunits: Milliunits;
      readonly netMilliunits: Milliunits;
    }
  | { readonly _tag: "Overflow" };

export type MovementClassification = {
  readonly movements: readonly ClassifiedMovement[];
  readonly refundsAdjusted: number;
  readonly refundsUnresolved: number;
  readonly balanceCheck: WalletBalanceCheck;
  readonly totals: WalletTotals;
};

const REFUND_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

type WalletIssue = "invalid_wallet_amount" | "invalid_refund_amount";

type WalletResolution =
  | { readonly _tag: "Amount"; readonly amountCents: Cents; readonly adjusted: boolean }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Issue"; readonly issue: WalletIssue }
  | { readonly _tag: "Provisional"; readonly amountCents: Cents; readonly reason: AmbiguityReason };

type IndexedPurchase = {
  time: number;
  nominal: number;
  remainingNominal: number;
  remainingWallet: number | null;
  walletOnly: boolean;
  benefitOnly: boolean;
};

type RefundFit =
  | { readonly kind: "restore"; readonly purchase: IndexedPurchase; readonly wallet: number }
  | { readonly kind: "inconsistent" }
  | { readonly kind: "unsplit" };

type PendingRefund = {
  readonly index: number;
  readonly time: number;
  readonly nominal: number;
  readonly reported: Cents;
};

const amountCents = (amount: MovementAmount): Cents | null =>
  amount._tag === "Amount" ? amount.cents : null;

const merchantKey = (name: string): string =>
  name.toLocaleLowerCase("it-IT").replace(/\s+/g, " ").trim();

function purchaseFunding(
  movement: SatispayMovement,
  signed: number,
): { wallet: number | null; walletOnly: boolean; benefitOnly: boolean } {
  const reported = movement.reportedWalletAmount;
  const walletSpent = reported._tag === "Absent" ? 0 : amountCents(reported);
  let benefits = 0;
  let benefitsKnown = true;
  for (const part of [movement.mealVoucherAmount, movement.flexBenefitAmount]) {
    if (!benefitsKnown || part._tag === "Absent") continue;
    if (part._tag === "Unreadable") {
      benefitsKnown = false;
      continue;
    }
    const next = makeCents(benefits + part.cents);
    if (next === null) benefitsKnown = false;
    else benefits = next;
  }
  // The purchase funding split is evidence only when it accounts for the whole nominal amount.
  if (
    walletSpent === null ||
    walletSpent > 0 ||
    !benefitsKnown ||
    walletSpent + benefits !== signed
  ) {
    return { wallet: null, walletOnly: false, benefitOnly: false };
  }
  const magnitude = -signed;
  // Math.abs keeps a zero wallet outflow as 0 rather than -0.
  const wallet = Math.abs(walletSpent);
  const benefit = Math.abs(benefits);
  return {
    wallet,
    walletOnly: benefit === 0 && wallet === magnitude,
    benefitOnly: wallet === 0 && benefit === magnitude,
  };
}

function refundFit(purchase: IndexedPurchase, refundNominal: number): RefundFit | null {
  if (purchase.remainingNominal <= 0 || refundNominal > purchase.remainingNominal) return null;
  if (purchase.remainingWallet === null) {
    return refundNominal === purchase.nominal ? { kind: "inconsistent" } : null;
  }
  // Closing the remaining nominal restores whatever wallet amount is left, including a mixed purchase.
  if (refundNominal === purchase.remainingNominal) {
    return { kind: "restore", purchase, wallet: purchase.remainingWallet };
  }
  if (purchase.walletOnly) return { kind: "restore", purchase, wallet: refundNominal };
  if (purchase.benefitOnly) return { kind: "restore", purchase, wallet: 0 };
  return { kind: "unsplit" };
}

function unmatchedReason(
  bucket: readonly IndexedPurchase[],
  first: number,
  last: number,
  refundNominal: number,
): AmbiguityReason {
  if (first === last) return "refund_purchase_not_in_export";
  for (let cursor = first; cursor < last; cursor++) {
    if (refundNominal <= bucket[cursor].remainingNominal) return "refund_purchase_funding_mismatch";
  }
  return "refund_exceeds_remaining_amount";
}

/** First index at or after `time`, or strictly after it when `inclusive` is set. */
function boundary(bucket: readonly { time: number }[], time: number, inclusive: boolean): number {
  let low = 0;
  let high = bucket.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bucket[middle].time < time || (inclusive && bucket[middle].time === time)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexPurchases(movements: readonly SatispayMovement[]): Map<string, IndexedPurchase[]> {
  const purchases = new Map<string, IndexedPurchase[]>();
  for (const movement of movements) {
    if (movement.kind !== "merchantPurchase" || movement.satispayApproval !== "approved") continue;
    const name = merchantKey(movement.name);
    const signed = amountCents(movement.nominalAmount);
    const time = movement.date._tag === "Valid" ? movement.date.instantMs : null;
    if (name === "" || signed === null || signed >= 0 || time === null) continue;
    const funding = purchaseFunding(movement, signed);
    const magnitude = -signed;
    const bucket = purchases.get(name) ?? [];
    bucket.push({
      time,
      nominal: magnitude,
      remainingNominal: magnitude,
      remainingWallet: funding.wallet,
      walletOnly: funding.walletOnly,
      benefitOnly: funding.benefitOnly,
    });
    purchases.set(name, bucket);
  }
  for (const bucket of purchases.values()) bucket.sort((left, right) => left.time - right.time);
  return purchases;
}

function resolveWallets(movements: readonly SatispayMovement[]): {
  readonly resolutions: WalletResolution[];
  readonly refundsAdjusted: number;
  readonly refundsUnresolved: number;
} {
  const resolutions: WalletResolution[] = movements.map((movement) => {
    const reported = movement.reportedWalletAmount;
    if (reported._tag === "Unreadable") return { _tag: "Issue", issue: "invalid_wallet_amount" };
    if (reported._tag === "Absent") return { _tag: "Empty" };
    return { _tag: "Amount", amountCents: reported.cents, adjusted: false };
  });
  let refundsAdjusted = 0;
  let refundsUnresolved = 0;
  const purchases = indexPurchases(movements);
  const pending: PendingRefund[] = [];
  const provisional = (index: number, reported: Cents, reason: AmbiguityReason) => {
    resolutions[index] = { _tag: "Provisional", amountCents: reported, reason };
    refundsUnresolved++;
  };

  for (const [index, movement] of movements.entries()) {
    if (movement.kind !== "merchantRefund") continue;
    // A benefit-only refund does not move the cash wallet.
    if (movement.reportedWalletAmount._tag === "Absent") continue;
    const reported = movement.reportedWalletAmount;
    if (reported._tag !== "Amount" || reported.cents <= 0) {
      resolutions[index] = { _tag: "Issue", issue: "invalid_refund_amount" };
      refundsUnresolved++;
      continue;
    }
    const nominal = movement.nominalAmount;
    if (nominal._tag !== "Amount" || nominal.cents <= 0 || movement.date._tag !== "Valid") {
      provisional(index, reported.cents, "invalid_refund_details");
      continue;
    }
    pending.push({
      index,
      time: movement.date.instantMs,
      nominal: nominal.cents,
      reported: reported.cents,
    });
  }

  // Earlier merchant refunds consume remaining wallet amount first. Equal timestamps follow
  // reverse-chronological file order, so the later row is the earlier movement.
  pending.sort((left, right) => left.time - right.time || right.index - left.index);
  for (const refund of pending) {
    const name = merchantKey(movements[refund.index].name);
    const bucket = name === "" ? [] : (purchases.get(name) ?? []);
    const first = boundary(bucket, refund.time - REFUND_WINDOW_MS, false);
    const last = boundary(bucket, refund.time, true);
    const fits: RefundFit[] = [];
    for (let cursor = first; cursor < last && fits.length < 2; cursor++) {
      const fit = refundFit(bucket[cursor], refund.nominal);
      if (fit) fits.push(fit);
    }
    if (fits.length !== 1) {
      provisional(
        refund.index,
        refund.reported,
        fits.length > 1
          ? "ambiguous_refund_purchase"
          : unmatchedReason(bucket, first, last, refund.nominal),
      );
      continue;
    }
    const fit = fits[0];
    if (fit.kind === "inconsistent") {
      provisional(refund.index, refund.reported, "refund_purchase_funding_mismatch");
      continue;
    }
    if (fit.kind === "unsplit") {
      provisional(refund.index, refund.reported, "partial_refund_split_unknown");
      continue;
    }
    const refunded = makeCents(fit.wallet);
    const walletLeft = fit.purchase.remainingWallet;
    const walletAfter = walletLeft === null ? null : makeCents(walletLeft - fit.wallet);
    if (refunded === null || walletAfter === null) {
      provisional(refund.index, refund.reported, "invalid_refund_details");
      continue;
    }
    fit.purchase.remainingNominal -= refund.nominal;
    fit.purchase.remainingWallet = walletAfter;
    const adjusted = refunded !== refund.reported;
    resolutions[refund.index] = { _tag: "Amount", amountCents: refunded, adjusted };
    if (adjusted) refundsAdjusted++;
  }
  return { resolutions, refundsAdjusted, refundsUnresolved };
}

function classifyMovement(
  movement: SatispayMovement,
  resolution: WalletResolution,
  importCutoff: CalendarDate | null,
): ClassifiedMovement {
  if (
    importCutoff !== null &&
    movement.date._tag === "Valid" &&
    movement.date.calendarDate < importCutoff
  ) {
    return { _tag: "SkippedMovement", movement, reason: "outside_import_period" };
  }
  if (resolution._tag === "Empty") {
    return { _tag: "SkippedMovement", movement, reason: "no_availability_movement" };
  }
  if (resolution._tag === "Issue") {
    return { _tag: "RejectedMovement", movement, reason: resolution.issue };
  }
  const amount = resolution.amountCents;
  if (amount === 0) {
    return { _tag: "SkippedMovement", movement, reason: "zero_availability_movement" };
  }
  if (movement.satispayMovementIdentifier._tag !== "Unique") {
    return { _tag: "RejectedMovement", movement, reason: "missing_or_duplicate_id" };
  }
  if (movement.date._tag !== "Valid") {
    return { _tag: "RejectedMovement", movement, reason: "invalid_date" };
  }
  if (movement.satispayApproval !== "approved") {
    return { _tag: "RejectedMovement", movement, reason: "not_approved" };
  }
  const amountMilliunits = centsToMilliunits(amount);
  if (amountMilliunits === null) {
    return { _tag: "RejectedMovement", movement, reason: "invalid_availability_amount" };
  }
  if (resolution._tag === "Provisional") {
    return {
      _tag: "ProvisionalTransaction",
      movement,
      provisionalWalletAmount: amount,
      amountMilliunits,
      reason: resolution.reason,
    };
  }
  return { _tag: "ImportCandidate", movement, walletAmount: amount, amountMilliunits };
}

function milliunitsOf(cents: number): Milliunits | null {
  if (!Number.isSafeInteger(cents)) return null;
  return makeMilliunits(cents * 10);
}

function walletBalanceCheck(
  movements: readonly SatispayMovement[],
  resolutions: readonly WalletResolution[],
  includesWalletBalance: boolean,
): WalletBalanceCheck {
  if (!includesWalletBalance || movements.length < 2) {
    return { status: "unavailable", reason: "insufficient_balance_snapshots" };
  }
  let previous: number | null = null;
  for (const movement of movements) {
    if (
      movement.date._tag !== "Valid" ||
      (previous !== null && movement.date.instantMs > previous)
    ) {
      return { status: "unavailable", reason: "export_not_reverse_chronological" };
    }
    previous = movement.date.instantMs;
  }
  const anchors: { index: number; balance: Cents }[] = [];
  for (const [index, movement] of movements.entries()) {
    const balance = amountCents(movement.walletBalance);
    if (balance !== null) anchors.push({ index, balance });
  }
  if (anchors.length < 2) {
    return { status: "unavailable", reason: "insufficient_balance_snapshots" };
  }
  const recent = anchors[0];
  const oldest = anchors[anchors.length - 1];
  // The oldest snapshot already includes that movement: exclude it from the compared interval.
  const considered = resolutions.slice(recent.index, oldest.index);
  if (considered.some((row) => row._tag === "Issue" || row._tag === "Provisional")) {
    return { status: "unavailable", reason: "unresolved_or_invalid_wallet_amount" };
  }
  const expected = recent.balance - oldest.balance;
  let calculated = 0;
  let safe = Number.isSafeInteger(expected);
  for (const row of considered) {
    if (row._tag === "Amount") calculated += row.amountCents;
    if (!Number.isSafeInteger(calculated)) safe = false;
  }
  const discrepancy = expected - calculated;
  const expectedChangeMilliunits = milliunitsOf(expected);
  const calculatedChangeMilliunits = milliunitsOf(calculated);
  const discrepancyMilliunits = milliunitsOf(discrepancy);
  if (
    !safe ||
    expectedChangeMilliunits === null ||
    calculatedChangeMilliunits === null ||
    discrepancyMilliunits === null
  ) {
    return { status: "unavailable", reason: "unsafe_money_range" };
  }
  return {
    status: discrepancy === 0 ? "ok" : "mismatch",
    expectedChangeMilliunits,
    calculatedChangeMilliunits,
    discrepancyMilliunits,
  };
}

function walletTotals(movements: readonly ClassifiedMovement[]): WalletTotals {
  let inflow = 0;
  let outflow = 0;
  for (const movement of movements) {
    if (movement._tag !== "ImportCandidate" && movement._tag !== "ProvisionalTransaction") continue;
    const amount =
      movement._tag === "ImportCandidate"
        ? movement.walletAmount
        : movement.provisionalWalletAmount;
    if (amount < 0) outflow += -amount;
    else inflow += amount;
    if (!Number.isSafeInteger(inflow) || !Number.isSafeInteger(outflow))
      return { _tag: "Overflow" };
  }
  const inflowCents = makeCents(inflow);
  const outflowCents = makeCents(outflow);
  const netCents = makeCents(inflow - outflow);
  if (inflowCents === null || outflowCents === null || netCents === null)
    return { _tag: "Overflow" };
  const inflowMilliunits = centsToMilliunits(inflowCents);
  const outflowMilliunits = centsToMilliunits(outflowCents);
  const netMilliunits = centsToMilliunits(netCents);
  if (inflowMilliunits === null || outflowMilliunits === null || netMilliunits === null) {
    return { _tag: "Overflow" };
  }
  return { _tag: "Exact", inflowMilliunits, outflowMilliunits, netMilliunits };
}

export function classifyMovements(
  satispayExport: SatispayExportRead,
  importCutoff: CalendarDate | null = null,
): MovementClassification {
  const { resolutions, refundsAdjusted, refundsUnresolved } = resolveWallets(
    satispayExport.movements,
  );
  const movements = satispayExport.movements.map((movement, index) =>
    classifyMovement(movement, resolutions[index], importCutoff),
  );
  return {
    movements,
    refundsAdjusted,
    refundsUnresolved,
    balanceCheck: walletBalanceCheck(
      satispayExport.movements,
      resolutions,
      satispayExport.includesWalletBalance,
    ),
    totals: walletTotals(movements),
  };
}
