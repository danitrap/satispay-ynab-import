import {
  parseCents,
  makeCents,
  makeMilliunits,
  WorksheetInputError,
  type Cents,
} from "./domain.ts";
import type { SheetCell } from "./spreadsheet.ts";

export type RefundReviewReason =
  | "ambiguous_refund_purchase"
  | "refund_purchase_not_in_export"
  | "refund_purchase_funding_mismatch"
  | "invalid_refund_details"
  | "refund_exceeds_remaining_amount"
  | "partial_refund_split_unknown";
type RefundResolution = {
  amountCents: Cents | null;
  issue?: string;
  reviewReason?: RefundReviewReason;
  adjusted?: boolean;
};
type BalanceAudit = {
  status: "ok" | "mismatch" | "unavailable";
  expectedChangeMilliunits?: number;
  calculatedChangeMilliunits?: number;
  discrepancyMilliunits?: number;
  reason?: string;
};
const text = (value: SheetCell): string =>
  value === null || value === undefined ? "" : String(value).trim();
const cents = parseCents;
function time(value: SheetCell): number | null {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.valueOf();
  const input = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const parsed = Date.parse(input + "T00:00:00.000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === input
    ? parsed
    : null;
}
function merchantName(value: SheetCell): string {
  const name = text(value).toLocaleLowerCase("it-IT").replace(/\s+/g, " ");
  return name === "-" ? "" : name;
}
type IndexedPurchase = {
  time: number;
  nominal: number;
  remainingNominal: number;
  remainingWallet: number | null;
  walletOnly: boolean;
  benefitOnly: boolean;
};
type RefundFit =
  | { kind: "restore"; purchase: IndexedPurchase; wallet: number }
  | { kind: "inconsistent" }
  | { kind: "unsplit" };
function purchaseFunding(
  row: SheetCell[],
  signed: number,
  availabilityAt: number,
  benefitAt: number[],
): { wallet: number | null; walletOnly: boolean; benefitOnly: boolean } {
  const originalAmount = cents(row[availabilityAt]);
  const walletSpent = originalAmount === null && !text(row[availabilityAt]) ? 0 : originalAmount;
  const benefitSum = benefitAt.reduce<number | null>((sum, at) => {
    if (sum === null) return null;
    const raw = row[at];
    const value = !text(raw) ? 0 : cents(raw);
    return value === null ? null : makeCents(sum + value);
  }, 0);
  // The purchase funding split is evidence only when it accounts for the whole nominal amount.
  if (
    walletSpent === null ||
    walletSpent > 0 ||
    benefitSum === null ||
    walletSpent + benefitSum !== signed
  ) {
    return { wallet: null, walletOnly: false, benefitOnly: false };
  }
  const magnitude = -signed;
  // Unary minus of a zero wallet outflow is -0, which must stay a plain zero wallet amount.
  const wallet = Math.abs(walletSpent);
  const benefit = Math.abs(benefitSum);
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
  bucket: IndexedPurchase[],
  first: number,
  last: number,
  refundNominal: number,
): RefundReviewReason {
  if (first === last) return "refund_purchase_not_in_export";
  for (let cursor = first; cursor < last; cursor++) {
    if (refundNominal <= bucket[cursor].remainingNominal) return "refund_purchase_funding_mismatch";
  }
  return "refund_exceeds_remaining_amount";
}
export function analyzeLedger(rows: SheetCell[][]): {
  resolved: RefundResolution[];
  refundsAdjusted: number;
  refundsUnresolved: number;
  balanceCheck: BalanceAudit;
} {
  if (!rows.length) throw new WorksheetInputError("EmptyWorksheet");
  const cols = rows[0].map(text);
  const idx = (name: string) => cols.indexOf(name);
  const needed = ["Data", "Nome", "Importo", "Tipo", "Stato", "Disponibilità"];
  if (needed.some((name) => idx(name) < 0)) throw new WorksheetInputError("MissingColumns");
  const records = rows.slice(1).filter((row) => row.some((v) => text(v) !== ""));
  const amounts = records.map((row) => cents(row[idx("Disponibilità")]));
  const invalidValue = records.map(
    (row) => text(row[idx("Disponibilità")]) !== "" && cents(row[idx("Disponibilità")]) === null,
  );
  const resolved: RefundResolution[] = amounts.map((value, i) => {
    const raw = records[i][idx("Disponibilità")];
    return invalidValue[i]
      ? { amountCents: null, issue: "invalid_wallet_amount" }
      : { amountCents: value === null && !text(raw) ? null : value };
  });
  let refundsAdjusted = 0,
    refundsUnresolved = 0;
  const maxDistance = 90 * 24 * 60 * 60 * 1000;
  const benefitAt = ["Buoni Pasto", "FlexBen"].flatMap((name) => {
    const at = idx(name);
    return at < 0 ? [] : [at];
  });
  // Index purchases once: the date window is binary-searched, and ambiguity stops the scan at two fits.
  const purchases = new Map<string, IndexedPurchase[]>();
  for (const row of records) {
    if (text(row[idx("Tipo")]) !== "🏬 a un Negozio" || text(row[idx("Stato")]) !== "✅ Approvato")
      continue;
    const name = merchantName(row[idx("Nome")]);
    const signed = cents(row[idx("Importo")]);
    const date = time(row[idx("Data")]);
    if (!name || signed === null || signed >= 0 || date === null) continue;
    const funding = purchaseFunding(row, signed, idx("Disponibilità"), benefitAt);
    const magnitude = -signed;
    const bucket = purchases.get(name) ?? [];
    bucket.push({
      time: date,
      nominal: magnitude,
      remainingNominal: magnitude,
      remainingWallet: funding.wallet,
      walletOnly: funding.walletOnly,
      benefitOnly: funding.benefitOnly,
    });
    purchases.set(name, bucket);
  }
  for (const bucket of purchases.values()) bucket.sort((a, b) => a.time - b.time);
  const boundary = (bucket: { time: number }[], date: number, inclusive: boolean): number => {
    let low = 0,
      high = bucket.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (bucket[middle].time < date || (inclusive && bucket[middle].time === date))
        low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const unresolved = (index: number, reported: Cents, reviewReason: RefundReviewReason) => {
    resolved[index] = { amountCents: reported, reviewReason };
    refundsUnresolved++;
  };
  const pending: { index: number; time: number; nominal: number; reported: Cents }[] = [];
  for (let i = 0; i < records.length; i++) {
    const refund = records[i];
    if (text(refund[idx("Tipo")]) !== "🔄 Rimborso") continue;
    const reported = amounts[i];
    // A benefit-only refund does not move the user's tracked wallet.
    if (!text(refund[idx("Disponibilità")])) continue;
    if (reported === null || reported <= 0) {
      resolved[i] = { amountCents: null, issue: "invalid_refund_amount" };
      refundsUnresolved++;
      continue;
    }
    const nominal = cents(refund[idx("Importo")]);
    const refundTime = time(refund[idx("Data")]);
    if (nominal === null || nominal <= 0 || refundTime === null) {
      unresolved(i, reported, "invalid_refund_details");
      continue;
    }
    pending.push({ index: i, time: refundTime, nominal, reported });
  }
  // Earlier merchant refunds consume remaining wallet amount first. Equal timestamps follow
  // reverse-chronological file order, so the later row is the earlier movement.
  pending.sort((a, b) => a.time - b.time || b.index - a.index);
  for (const refund of pending) {
    const name = merchantName(records[refund.index][idx("Nome")]);
    const bucket = name ? (purchases.get(name) ?? []) : [];
    const first = boundary(bucket, refund.time - maxDistance, false);
    const last = boundary(bucket, refund.time, true);
    const fits: RefundFit[] = [];
    for (let cursor = first; cursor < last && fits.length < 2; cursor++) {
      const fit = refundFit(bucket[cursor], refund.nominal);
      if (fit) fits.push(fit);
    }
    if (fits.length !== 1) {
      unresolved(
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
      unresolved(refund.index, refund.reported, "refund_purchase_funding_mismatch");
      continue;
    }
    if (fit.kind === "unsplit") {
      unresolved(refund.index, refund.reported, "partial_refund_split_unknown");
      continue;
    }
    const refundedCents = makeCents(fit.wallet);
    const walletLeft = fit.purchase.remainingWallet;
    if (refundedCents === null || walletLeft === null) {
      unresolved(refund.index, refund.reported, "invalid_refund_details");
      continue;
    }
    fit.purchase.remainingNominal -= refund.nominal;
    fit.purchase.remainingWallet = walletLeft - fit.wallet;
    resolved[refund.index] = {
      amountCents: refundedCents,
      adjusted: refundedCents !== refund.reported,
    };
    if (refundedCents !== refund.reported) refundsAdjusted++;
  }

  const saldo = idx("Disponibilità dopo la transazione");
  let balanceCheck: BalanceAudit = {
    status: "unavailable",
    reason: "insufficient_balance_snapshots",
  };
  if (saldo >= 0 && records.length >= 2) {
    const dates = records.map((row) => time(row[idx("Data")]));
    if (dates.some((v) => v === null) || dates.some((d, i) => i > 0 && d! > dates[i - 1]!)) {
      balanceCheck = { status: "unavailable", reason: "export_not_reverse_chronological" };
    } else {
      const anchors = records
        .map((row, index) => ({ index, balance: cents(row[saldo]) }))
        .filter((a): a is { index: number; balance: Cents } => a.balance !== null);
      if (anchors.length >= 2) {
        const recent = anchors[0],
          oldest = anchors[anchors.length - 1];
        // The oldest snapshot already includes that transaction: exclude its movement.
        const considered = resolved.slice(recent.index, oldest.index);
        if (considered.some((x) => x.issue || x.reviewReason)) {
          balanceCheck = { status: "unavailable", reason: "unresolved_or_invalid_wallet_amount" };
        } else {
          const expected = recent.balance - oldest.balance;
          let calculated = 0;
          let safe = true;
          for (const row of considered) {
            calculated += row.amountCents ?? 0;
            if (!Number.isSafeInteger(calculated)) safe = false;
          }
          const discrepancy = expected - calculated;
          const values = [expected * 10, calculated * 10, discrepancy * 10];
          balanceCheck =
            safe && values.every((value) => makeMilliunits(value) !== null)
              ? {
                  status: discrepancy === 0 ? "ok" : "mismatch",
                  expectedChangeMilliunits: expected * 10,
                  calculatedChangeMilliunits: calculated * 10,
                  discrepancyMilliunits: discrepancy * 10,
                }
              : { status: "unavailable", reason: "unsafe_money_range" };
        }
      }
    }
  }
  return { resolved, refundsAdjusted, refundsUnresolved, balanceCheck };
}
