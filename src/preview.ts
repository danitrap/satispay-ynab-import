/** A conservative, side-effect-free proposed YNAB import plan for Satispay. */
import { analyzeLedger } from "./ledger.ts";
export type Cell = string | number | boolean | Date | null | undefined;
export type PreviewRow = {
  decision: "include" | "skip" | "review";
  reason: string;
  type: string;
  amountMilliunits?: number;
};

function cellText(value: Cell): string {
  return value === undefined || value === null ? "" : String(value).trim();
}
function asCents(value: Cell): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 0.0001 || !Number.isSafeInteger(cents)) return null;
  return cents;
}
function isValidDate(value: Cell): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const date = new Date(value.trim() + "T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.trim();
}
function classify(type: string, amountCents: number, status: string, dateValid: boolean, validId: boolean): PreviewRow {
  if (!validId) return { decision: "review", reason: "missing_or_duplicate_id", type };
  if (!dateValid) return { decision: "review", reason: "invalid_date", type };
  if (status !== "✅ Approvato") return { decision: "review", reason: "not_approved", type };
  return { decision: "include", reason: amountCents < 0 ? "wallet_outflow" : "wallet_inflow", type, amountMilliunits: amountCents * 10 };
}

export function previewSatispay(rows: Cell[][]) {
  if (!rows.length) throw new Error("Empty worksheet");
  const [headers, ...unfiltered] = rows;
  const data=unfiltered.filter(row=>row.some(value=>cellText(value)!==""));
  const ledger=analyzeLedger([headers,...data]);
  const fields = headers.map(cellText);
  const find = (name: string) => fields.indexOf(name);
  const required = ["Data", "Importo", "Disponibilità", "Tipo", "Stato"];
  if (required.some(name => find(name) < 0)) throw new Error("Missing required Satispay columns");
  const idIndex = fields.findIndex(name => name === "ID" || name.startsWith("ID ("));
  if (idIndex < 0) throw new Error("Missing Satispay transaction ID column");
  const idCounts = new Map<string,number>();
  for (const row of data) {
    const id = cellText(row[idIndex]);
    if (id) idCounts.set(id,(idCounts.get(id) ?? 0)+1);
  }
  const all: PreviewRow[] = [];
  const byType = new Map<string,{ include: number; skip: number; review: number }>();
  let outflowCents = 0;
  let inflowCents = 0;
  const byReason = new Map<string,number>();
  for (const [index,row] of data.entries()) {
    const type=cellText(row[find("Tipo")]) || "(vuoto)";
    const raw= row[find("Disponibilità")];
    const rawText=cellText(raw);
    const resolution=ledger.resolved[index];
    const amountCents=resolution?.amountCents ?? null;
    let result: PreviewRow;
    if (rawText === "") result={decision:"skip",reason:"no_availability_movement",type};
    else if (resolution?.issue) result={decision:"review",reason:resolution.issue,type};
    else if (amountCents === null) result={decision:"review",reason:"invalid_availability_amount",type};
    else if (amountCents === 0) result={decision:"skip",reason:"zero_availability_movement",type};
    else {
      const id=cellText(row[idIndex]);
      result=classify(type,amountCents,cellText(row[find("Stato")]),isValidDate(row[find("Data")]),id !== "" && typeof row[idIndex] === "string" && idCounts.get(id) === 1);
    }
    all.push(result);
    const bucket=byType.get(type) ?? {include:0,skip:0,review:0};
    bucket[result.decision]++;
    byType.set(type,bucket);
    byReason.set(result.reason,(byReason.get(result.reason) ?? 0)+1);
    if (result.decision === "include") {
      if (amountCents! < 0) outflowCents += -amountCents!;
      else inflowCents += amountCents!;
    }
  }
  const count=(decision:PreviewRow["decision"])=>all.filter(x=>x.decision===decision).length;
  // Keep arithmetic in integer cents and serialize display amounts as strings.
  // This prevents Apple Shortcuts from showing binary floating-point artifacts.
  const money=(cents:number):string=>{
    const abs=Math.abs(cents);
    return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2,"0")}`;
  };
  return {
    mode:"preview-only",
    rowCount:all.length,
    eligible:count("include"),
    skipped:count("skip"),
    requiresReview:count("review"),
    outflowEur:money(outflowCents),
    inflowEur:money(inflowCents),
    netEur:money(inflowCents-outflowCents),
    outflowMilliunits:outflowCents*10,
    inflowMilliunits:inflowCents*10,
    netMilliunits:(inflowCents-outflowCents)*10,
    byType:Object.fromEntries([...byType.entries()]),
    byReason:Object.fromEntries([...byReason.entries()]),
    refundsAdjusted:ledger.refundsAdjusted,
    refundsUnresolved:ledger.refundsUnresolved,
    balanceCheck:ledger.balanceCheck,
    imported:0,
    message:"Dry run only. No transactions sent to YNAB. Transfers can be adjusted manually in YNAB."
  };
}
