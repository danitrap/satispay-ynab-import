import {
  parseCents,
  makeCents,
  makeMilliunits,
  negateCents,
  WorksheetInputError,
  type Cents,
} from "./domain.ts";
import type { SheetCell } from "./spreadsheet.ts";

export type RefundReviewReason =
  | "ambiguous_refund_purchase"
  | "refund_purchase_not_in_export"
  | "refund_purchase_funding_mismatch"
  | "invalid_refund_details";
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
  // Index purchases once: large exports must not rescan every row for every refund.
  const purchases = new Map<string, { index: number; time: number }[]>();
  for (const [index, row] of records.entries()) {
    if (text(row[idx("Tipo")]) !== "🏬 a un Negozio" || text(row[idx("Stato")]) !== "✅ Approvato")
      continue;
    const name = merchantName(row[idx("Nome")]);
    const nominal = cents(row[idx("Importo")]);
    const date = time(row[idx("Data")]);
    if (!name || nominal === null || date === null) continue;
    const key = JSON.stringify([name, nominal]);
    const bucket = purchases.get(key) ?? [];
    bucket.push({ index, time: date });
    purchases.set(key, bucket);
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
      resolved[i] = { amountCents: reported, reviewReason: "invalid_refund_details" };
      refundsUnresolved++;
      continue;
    }
    const name = merchantName(refund[idx("Nome")]);
    const bucket = name ? (purchases.get(JSON.stringify([name, -nominal])) ?? []) : [];
    const first = boundary(bucket, refundTime - maxDistance, false);
    const last = boundary(bucket, refundTime, true);
    const candidateCount = last - first;
    if (candidateCount !== 1) {
      resolved[i] = {
        amountCents: reported,
        reviewReason: candidateCount
          ? "ambiguous_refund_purchase"
          : "refund_purchase_not_in_export",
      };
      refundsUnresolved++;
      continue;
    }
    const original = records[bucket[first].index];
    const originalAmount = cents(original[idx("Disponibilità")]);
    const walletSpent =
      originalAmount === null && !text(original[idx("Disponibilità")]) ? 0 : originalAmount;
    const benefitFields = ["Buoni Pasto", "FlexBen"].filter((name) => idx(name) >= 0);
    const benefitSum = benefitFields.reduce<number | null>((sum, name) => {
      if (sum === null) return null;
      const raw = original[idx(name)];
      const value = !text(raw) ? 0 : cents(raw);
      return value === null ? null : makeCents(sum + value);
    }, 0);
    // A fully refunded merchant purchase must have a consistent funding split.
    if (
      walletSpent === null ||
      walletSpent > 0 ||
      benefitSum === null ||
      walletSpent + benefitSum !== -nominal
    ) {
      resolved[i] = { amountCents: reported, reviewReason: "refund_purchase_funding_mismatch" };
      refundsUnresolved++;
      continue;
    }
    const refundedCents = walletSpent === 0 ? makeCents(0)! : negateCents(walletSpent);
    resolved[i] = { amountCents: refundedCents, adjusted: refundedCents !== reported };
    if (refundedCents !== reported) refundsAdjusted++;
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
