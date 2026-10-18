import { Effect } from "effect";
import { previewSatispay } from "./preview.ts";

/** Inspection-only Satispay worksheet diagnostics. No transaction-level details leave the Worker. */
export type SheetCell = string | number | boolean | Date | null | undefined;

function present(v: SheetCell): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}
function numberValue(v: SheetCell): number | null {
  if (!present(v) || v instanceof Date || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\s|\u00a0|€/g,"").replace(/−/g,"-");
  const parenthesized = /^\(.*\)$/.test(s);
  if (parenthesized) s = s.slice(1,-1);
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g,"").replace(",",".") : s.replace(/,/g,"");
  } else if (s.includes(",")) s = s.replace(",",".");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (parenthesized ? -n : n) : null;
}
function amountStats(values: SheetCell[]) {
  const out = { populated: 0, positive: 0, negative: 0, zero: 0, unparseable: 0, numberCells: 0, textCells: 0 };
  for (const v of values) {
    if (!present(v)) continue;
    out.populated++;
    if (typeof v === "number") out.numberCells++;
    if (typeof v === "string") out.textCells++;
    const n = numberValue(v);
    if (n === null) out.unparseable++;
    else if (n > 0) out.positive++;
    else if (n < 0) out.negative++;
    else out.zero++;
  }
  return out;
}
function groupedCounts(values: SheetCell[]) {
  const counts = new Map<string,number>();
  for (const v of values) {
    const label = present(v) ? String(v).trim() : "(vuoto)";
    // Tipo and Stato should be controlled vocabularies. Cap output to avoid exposing free-form text.
    const normalized = label.length > 80 ? "(valore lungo)" : label;
    counts.set(normalized,(counts.get(normalized) ?? 0)+1);
  }
  const entries=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
  // An unexpected large cardinality likely means this is not a categorical field.
  if (entries.length > 30) return { uniqueValues:entries.length, counts: [], warning: "Too many distinct values; categories hidden" };
  return { uniqueValues: entries.length, counts: entries.map(([value,count])=>({value,count})) };
}
export function summarizeSheet(rows: SheetCell[][]) {
  const nonEmpty = rows.filter(row => row.some(present));
  if (!nonEmpty.length) throw new Error("Empty worksheet");
  const [header, ...body] = nonEmpty;
  if (header.length < 2) throw new Error("Expected at least two columns");
  const columns = header.map((value, index) => String(value ?? `Column ${index+1}`));
  const position = (name: string) => columns.findIndex(col => col.trim().toLocaleLowerCase("it-IT") === name.toLocaleLowerCase("it-IT"));
  const field = (name:string): SheetCell[] => {
    const i=position(name);
    return i<0 ? [] : body.map(row => row[i]);
  };
  const idIndex = columns.findIndex(col => col.trim() === "ID" || col.startsWith("ID ("));
  const idValues = idIndex<0 ? [] : body.map(row=>row[idIndex]);
  const storedIds=idValues.filter(present);
  const distinctIds=new Set(storedIds.map(v => `${typeof v}:${String(v).trim()}`));
  const dates=field("Data");
  const fundingNames=["Disponibilità","Buoni Pasto","FlexBen"];
  const monetaryNames=["Importo", ...fundingNames, "Disponibilità dopo la transazione"];
  return {
    columns,
    rowCount: body.length,
    sheet: 1,
    analysis: {
      types: position("Tipo")>=0 ? groupedCounts(field("Tipo")) : null,
      statuses: position("Stato")>=0 ? groupedCounts(field("Stato")) : null,
      identifiers: {
        columnFound: idIndex>=0,
        present: storedIds.length,
        missing: body.length-storedIds.length,
        distinct: distinctIds.size,
        duplicateRows: storedIds.length-distinctIds.size,
        numericCells: storedIds.filter(v=>typeof v==="number").length,
      },
      dateCellTypes: {
        date: dates.filter(v=>v instanceof Date).length,
        number: dates.filter(v=>typeof v==="number").length,
        text: dates.filter(v=>typeof v==="string").length,
        empty: dates.filter(v=>!present(v)).length,
      },
      monetaryColumns: Object.fromEntries(monetaryNames.filter(name=>position(name)>=0).map(name=>[name,amountStats(field(name))])),
    }
  };
}
export class WorkbookError extends Error {
  readonly _tag="WorkbookError";
  constructor(message:string) { super(message); this.name="WorkbookError"; }
}

/** Untrusted xlsx decoding happens at the I/O boundary, errors remain typed. */
export const readSheetEffect=(file:ArrayBuffer)=>Effect.tryPromise({
  try: async ()=>{
    const { readSheet }=await import("read-excel-file/universal");
    return await readSheet(file) as unknown as SheetCell[][];
  },
  catch:()=>new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file.")
});
export const inspectXlsxEffect=(file:ArrayBuffer)=>readSheetEffect(file).pipe(
  Effect.flatMap(rows=>Effect.try({
    try:()=>summarizeSheet(rows),
    catch:()=>new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file.")
  }))
);
export const previewXlsxEffect=(file:ArrayBuffer)=>readSheetEffect(file).pipe(
  Effect.flatMap(rows=>Effect.try({
    try:()=>previewSatispay(rows),
    catch:()=>new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file.")
  }))
);

// Promise adapters for clients outside the Effect runtime.
export const inspectXlsx=(file:ArrayBuffer)=>Effect.runPromise(inspectXlsxEffect(file));
export const previewXlsx=(file:ArrayBuffer)=>Effect.runPromise(previewXlsxEffect(file));
