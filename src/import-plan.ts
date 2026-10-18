import type { SheetCell } from "./spreadsheet.ts";

export type ImportCandidate = {
  satispayId: string;
  date: string;
  amountMilliunits: number;
  payee: string;
  memo: string;
  type: string;
};
export type ImportPlan = {
  candidates: ImportCandidate[];
  counts: { exported: number; olderThanStart: number; withoutAvailability: number; rejected: number; inScope: number };
  issues: Record<string,number>;
  fromDate: string;
  inflowMilliunits: number;
  outflowMilliunits: number;
  netMilliunits: number;
};

function text(v: SheetCell): string {
  return v === undefined || v === null ? "" : String(v).trim();
}
function isDateString(d:string):boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const date=new Date(d+"T00:00:00.000Z");
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0,10) === d;
}
export function parseDate(value: SheetCell):string|null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0,10);
  const s=text(value);
  return isDateString(s) ? s : null;
}
function asMilliunits(value: SheetCell):number|null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents=Math.round(value*100);
  if (Math.abs(value*100-cents)>0.0001 || !Number.isSafeInteger(cents)) return null;
  return cents*10;
}
function safeLabel(s:string,fallback:string,maximum:number):string {
  return (s || fallback).slice(0,maximum);
}
export function buildImportPlan(rows: SheetCell[][], fromDate:string):ImportPlan {
  if (!isDateString(fromDate)) throw new Error("Invalid YNAB_IMPORT_FROM: expected YYYY-MM-DD");
  if (!rows.length) throw new Error("Empty Satispay spreadsheet");
  const names=rows[0].map(text);
  const get=(name:string)=>names.indexOf(name);
  const required=["Data","Nome","Descrizione","Importo","Tipo","Stato","Disponibilità"];
  if (required.some(n=>get(n)<0)) throw new Error("Missing Satispay export columns");
  const idIndex=names.findIndex(n=>n==="ID" || n.startsWith("ID ("));
  if (idIndex<0) throw new Error("Missing Satispay transaction ID column");
  const data=rows.slice(1).filter(r=>r.some(cell=>text(cell)!==""));
  const counts={exported:data.length,olderThanStart:0,withoutAvailability:0,rejected:0,inScope:0};
  const issues: Record<string,number>={};
  const candidates:ImportCandidate[]=[];
  const ids=new Map<string,number>();
  for (const row of data) {
    const id=text(row[idIndex]);
    if (id) ids.set(id,(ids.get(id)??0)+1);
  }
  const issue=(reason:string)=>{counts.rejected++;issues[reason]=(issues[reason]??0)+1;};
  for (const row of data) {
    const date=parseDate(row[get("Data")]);
    if (date && date<fromDate) {counts.olderThanStart++;continue;}
    const avail=row[get("Disponibilità")];
    if (avail===undefined || avail===null || text(avail)==="") {counts.withoutAvailability++;continue;}
    if (!date) {issue("invalid_date");continue;}
    const amount=asMilliunits(avail);
    if (amount===null) {issue("invalid_availability_amount");continue;}
    if (amount===0) {counts.withoutAvailability++;continue;}
    const idCell=row[idIndex];
    const id=text(idCell);
    if (!id || typeof idCell!=="string" || ids.get(id)!==1) {issue("missing_nontext_or_duplicate_id");continue;}
    if (text(row[get("Stato")])!=="✅ Approvato") {issue("not_approved");continue;}
    const type=text(row[get("Tipo")]);
    const isPayment=type==="🏬 a un Negozio" && amount<0;
    const isCredit=(type==="🎖️ Punti" || type==="Rimborso") && amount>0;
    if (!isPayment && !isCredit) {issue("unknown_or_transfer_type");continue;}
    const rawPayee=text(row[get("Nome")]);
    const memo=text(row[get("Descrizione")]);
    candidates.push({
      satispayId:id,date,amountMilliunits:amount,
      payee:isCredit && type==="🎖️ Punti" ? "Satispay Cashback" : safeLabel(rawPayee,"Satispay",80),
      memo:safeLabel(memo,"",200),type
    });
  }
  candidates.sort((a,b)=>a.date.localeCompare(b.date)||a.satispayId.localeCompare(b.satispayId));
  counts.inScope=candidates.length;
  let inflowMilliunits=0,outflowMilliunits=0;
  for(const candidate of candidates){
    if(candidate.amountMilliunits>0)inflowMilliunits+=candidate.amountMilliunits;
    else outflowMilliunits+=-candidate.amountMilliunits;
  }
  return {candidates,counts,issues,fromDate,inflowMilliunits,outflowMilliunits,netMilliunits:inflowMilliunits-outflowMilliunits};
}
export function summarizeImportPlan(plan:ImportPlan) {
  return {
    ...plan.counts,
    issues:plan.issues,
    fromDate:plan.fromDate,
    inflowMilliunits:plan.inflowMilliunits,
    outflowMilliunits:plan.outflowMilliunits,
    netMilliunits:plan.netMilliunits,
    // No payees, memo, IDs or transaction-level amounts in API responses.
    eligible:plan.candidates.length
  };
}
