/** A conservative, side-effect-free proposed YNAB import plan for Satispay. */
export type Cell = string | number | boolean | Date | null | undefined;
export type PreviewRow = {
  decision: "include" | "skip" | "review";
  reason: string;
  type: string;
  amountMilliunits?: number;
};

const knownPaymentTypes = new Set(["🏬 a un Negozio"]);
const knownCreditTypes = new Set(["🎖️ Punti", "Rimborso"]);

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
  if (knownPaymentTypes.has(type)) return { decision: "include", reason: amountCents < 0 ? "payment" : "merchant_credit", type, amountMilliunits: amountCents * 10 };
  if (knownCreditTypes.has(type) && amountCents > 0) return { decision: "include", reason: "cashback_or_refund", type, amountMilliunits: amountCents * 10 };
  return { decision: "review", reason: "type_requires_mapping", type };
}

export function previewSatispay(rows: Cell[][]) {
  if (!rows.length) throw new Error("Empty worksheet");
  const [headers, ...data] = rows;
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
  for (const row of data) {
    if (row.every(value => cellText(value) === "")) continue;
    const type=cellText(row[find("Tipo")]) || "(vuoto)";
    const raw= row[find("Disponibilità")];
    const rawText=cellText(raw);
    const cents=asCents(raw);
    let result: PreviewRow;
    if (rawText === "") result={decision:"skip",reason:"no_availability_movement",type};
    else if (cents === null) result={decision:"review",reason:"invalid_availability_amount",type};
    else if (cents === 0) result={decision:"skip",reason:"zero_availability_movement",type};
    else {
      const id=cellText(row[idIndex]);
      result=classify(type,cents,cellText(row[find("Stato")]),isValidDate(row[find("Data")]),id !== "" && idCounts.get(id) === 1);
    }
    all.push(result);
    const bucket=byType.get(type) ?? {include:0,skip:0,review:0};
    bucket[result.decision]++;
    byType.set(type,bucket);
    byReason.set(result.reason,(byReason.get(result.reason) ?? 0)+1);
    if (result.decision === "include") {
      if (cents! < 0) outflowCents += -cents!;
      else inflowCents += cents!;
    }
  }
  const count=(decision:PreviewRow["decision"])=>all.filter(x=>x.decision===decision).length;
  const money=(cents:number)=>Math.round(cents)/100;
  return {
    mode:"preview-only",
    rowCount:all.length,
    eligible:count("include"),
    skipped:count("skip"),
    requiresReview:count("review"),
    outflowEur:money(outflowCents),
    inflowEur:money(inflowCents),
    netEur:money(inflowCents-outflowCents),
    byType:Object.fromEntries([...byType.entries()]),
    byReason:Object.fromEntries([...byReason.entries()]),
    imported:0,
    message:"Dry run only. No transactions sent to YNAB; Fineco top-ups need transfer handling before live import."
  };
}
