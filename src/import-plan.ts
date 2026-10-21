import {
  calendarDate,
  centsToMilliunits,
  makeMilliunits,
  satispayTransactionId,
  PlanInputError,
  type CalendarDate,
  type Milliunits,
  type SatispayTransactionId,
} from "./domain.ts";
import type { SheetCell } from "./spreadsheet.ts";
import { analyzeLedger } from "./ledger.ts";

export type ImportCandidate = {
  satispayId: SatispayTransactionId;
  date: CalendarDate;
  amountMilliunits: Milliunits;
  payee: string;
  memo: string;
  type: string;
};
export type ImportPlan = {
  candidates: ImportCandidate[];
  counts: {
    exported: number;
    olderThanStart: number;
    withoutAvailability: number;
    rejected: number;
    inScope: number;
  };
  issues: Record<string, number>;
  fromDate: CalendarDate;
  inflowMilliunits: Milliunits;
  outflowMilliunits: Milliunits;
  netMilliunits: Milliunits;
  refundsAdjusted: number;
  refundsUnresolved: number;
  balanceCheck: ReturnType<typeof analyzeLedger>["balanceCheck"];
};

function text(v: SheetCell): string {
  return v === undefined || v === null ? "" : String(v).trim();
}
export function parseDate(value: SheetCell): CalendarDate | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf()))
    return calendarDate(value.toISOString().slice(0, 10));
  const s = text(value);
  return calendarDate(s);
}
function safeLabel(s: string, fallback: string, maximum: number): string {
  return (s || fallback).slice(0, maximum);
}
export function buildImportPlan(rows: SheetCell[][], fromDate: string): ImportPlan {
  const cutoff = calendarDate(fromDate);
  if (!cutoff) throw new PlanInputError("InvalidCutoff");
  if (!rows.length) throw new PlanInputError("EmptyWorkbook");
  const names = rows[0].map(text);
  const get = (name: string) => names.indexOf(name);
  const required = ["Data", "Nome", "Descrizione", "Importo", "Tipo", "Stato", "Disponibilità"];
  if (required.some((n) => get(n) < 0)) throw new PlanInputError("MissingColumns");
  const idIndex = names.findIndex((n) => n === "ID" || n.startsWith("ID ("));
  if (idIndex < 0) throw new PlanInputError("MissingIdColumn");
  const data = rows.slice(1).filter((r) => r.some((cell) => text(cell) !== ""));
  const ledger = analyzeLedger([rows[0], ...data]);
  const counts = {
    exported: data.length,
    olderThanStart: 0,
    withoutAvailability: 0,
    rejected: 0,
    inScope: 0,
  };
  const issues: Record<string, number> = {};
  const candidates: ImportCandidate[] = [];
  const ids = new Map<string, number>();
  for (const row of data) {
    const id = text(row[idIndex]);
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  const issue = (reason: string) => {
    counts.rejected++;
    issues[reason] = (issues[reason] ?? 0) + 1;
  };
  for (const [rowIndex, row] of data.entries()) {
    const date = parseDate(row[get("Data")]);
    if (date && date < fromDate) {
      counts.olderThanStart++;
      continue;
    }
    const avail = row[get("Disponibilità")];
    if (avail === undefined || avail === null || text(avail) === "") {
      counts.withoutAvailability++;
      continue;
    }
    if (!date) {
      issue("invalid_date");
      continue;
    }
    const resolution = ledger.resolved[rowIndex];
    if (resolution?.issue) {
      issue(resolution.issue);
      continue;
    }
    const amount =
      resolution?.amountCents === null || resolution === undefined
        ? null
        : centsToMilliunits(resolution.amountCents);
    if (amount === null) {
      issue("invalid_availability_amount");
      continue;
    }
    if (amount === 0) {
      counts.withoutAvailability++;
      continue;
    }
    const idCell = row[idIndex];
    const id = text(idCell);
    if (!id || typeof idCell !== "string" || ids.get(id) !== 1) {
      issue("missing_nontext_or_duplicate_id");
      continue;
    }
    if (text(row[get("Stato")]) !== "✅ Approvato") {
      issue("not_approved");
      continue;
    }
    // Every wallet movement is imported by sign, with no automatic transfers.
    const type = text(row[get("Tipo")]);
    const rawPayee = text(row[get("Nome")]);
    const fallbackPayee = type ? "Satispay — " + type : "Satispay";
    const payee = rawPayee && rawPayee !== "-" ? rawPayee : fallbackPayee;
    const memo = text(row[get("Descrizione")]);
    candidates.push({
      satispayId: satispayTransactionId(id)!,
      date,
      amountMilliunits: amount,
      payee:
        amount > 0 && type === "🎖️ Punti" ? "Satispay Cashback" : safeLabel(payee, "Satispay", 80),
      memo: safeLabel(memo, "", 200),
      type,
    });
  }
  candidates.sort(
    (a, b) => a.date.localeCompare(b.date) || a.satispayId.localeCompare(b.satispayId),
  );
  counts.inScope = candidates.length;
  let inflowMilliunits = 0,
    outflowMilliunits = 0;
  for (const candidate of candidates) {
    if (candidate.amountMilliunits > 0) inflowMilliunits += candidate.amountMilliunits;
    else outflowMilliunits += -candidate.amountMilliunits;
    if (!Number.isSafeInteger(inflowMilliunits) || !Number.isSafeInteger(outflowMilliunits))
      throw new PlanInputError("AmountOverflow");
  }
  const inflow = makeMilliunits(inflowMilliunits);
  const outflow = makeMilliunits(outflowMilliunits);
  const net = makeMilliunits(inflowMilliunits - outflowMilliunits);
  if (inflow === null || outflow === null || net === null)
    throw new PlanInputError("AmountOverflow");
  return {
    candidates,
    counts,
    issues,
    fromDate: cutoff,
    inflowMilliunits: inflow,
    outflowMilliunits: outflow,
    netMilliunits: net,
    refundsAdjusted: ledger.refundsAdjusted,
    refundsUnresolved: ledger.refundsUnresolved,
    balanceCheck: ledger.balanceCheck,
  };
}
export function summarizeImportPlan(plan: ImportPlan) {
  return {
    ...plan.counts,
    issues: plan.issues,
    fromDate: plan.fromDate,
    inflowMilliunits: plan.inflowMilliunits,
    outflowMilliunits: plan.outflowMilliunits,
    netMilliunits: plan.netMilliunits,
    refundsAdjusted: plan.refundsAdjusted,
    refundsUnresolved: plan.refundsUnresolved,
    balanceCheck: plan.balanceCheck,
    // No payees, memo, IDs or transaction-level amounts in API responses.
    eligible: plan.candidates.length,
  };
}
