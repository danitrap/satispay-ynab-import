import type { SheetCell } from "./spreadsheet.ts";

type RefundResolution = { amountCents: number | null; issue?: string; adjusted?: boolean };
type BalanceAudit = {
  status: "ok" | "mismatch" | "unavailable";
  expectedChangeMilliunits?: number;
  calculatedChangeMilliunits?: number;
  discrepancyMilliunits?: number;
  reason?: string;
};
const text = (value: SheetCell): string => value === null || value === undefined ? "" : String(value).trim();
function cents(value: SheetCell): number | null {
  if(typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value * 100);
  return Number.isSafeInteger(n) && Math.abs(value * 100 - n) < 0.0001 ? n : null;
}
function time(value: SheetCell): number | null {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.valueOf();
  const input = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const parsed = Date.parse(input + "T00:00:00.000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,10) === input ? parsed : null;
}
function compareName(a:SheetCell,b:SheetCell):boolean {
  const x=text(a).toLocaleLowerCase("it-IT").replace(/\s+/g," ");
  const y=text(b).toLocaleLowerCase("it-IT").replace(/\s+/g," ");
  return x!=="" && x!=="-" && x===y;
}
export function analyzeLedger(rows:SheetCell[][]):{
  resolved:RefundResolution[];
  refundsAdjusted:number;
  refundsUnresolved:number;
  balanceCheck:BalanceAudit;
} {
  if(!rows.length) throw new Error("Empty worksheet");
  const cols=rows[0].map(text);
  const idx=(name:string)=>cols.indexOf(name);
  const needed=["Data","Nome","Importo","Tipo","Stato","Disponibilità"];
  if(needed.some(name=>idx(name)<0))throw new Error("Missing Satispay columns for ledger analysis");
  const records=rows.slice(1).filter(row=>row.some(v=>text(v)!==""));
  const amounts=records.map(row=>cents(row[idx("Disponibilità")]));
  const invalidValue=records.map(row=>text(row[idx("Disponibilità")])!=="" && cents(row[idx("Disponibilità")])===null);
  const resolved: RefundResolution[]=amounts.map((value,i)=>{
    const raw=records[i][idx("Disponibilità")];
    return invalidValue[i] ? {amountCents:null,issue:"invalid_wallet_amount"} : {amountCents: value===null && !text(raw) ? null : value};
  });
  let refundsAdjusted=0,refundsUnresolved=0;
  const maxDistance=90*24*60*60*1000;
  for(let i=0;i<records.length;i++) {
    const refund=records[i];
    if(text(refund[idx("Tipo")])!=="🔄 Rimborso")continue;
    const reported=amounts[i];
    // A benefit-only refund does not move the user's tracked wallet.
    if(!text(refund[idx("Disponibilità")])) continue;
    if(reported===null || reported<=0) {
      resolved[i]={amountCents:null,issue:"invalid_refund_amount"};
      refundsUnresolved++;
      continue;
    }
    const nominal=cents(refund[idx("Importo")]);
    const refundTime=time(refund[idx("Data")]);
    if(nominal===null || nominal<=0 || refundTime===null) {
      resolved[i]={amountCents:null,issue:"invalid_refund_details"};
      refundsUnresolved++;
      continue;
    }
    const candidates=records.filter((original,j)=>{
      if(i===j || text(original[idx("Tipo")])!=="🏬 a un Negozio"
        || text(original[idx("Stato")])!=="✅ Approvato")return false;
      const originalTime=time(original[idx("Data")]);
      if(originalTime===null || originalTime>refundTime || refundTime-originalTime>maxDistance)return false;
      return cents(original[idx("Importo")])===-nominal
        && compareName(original[idx("Nome")],refund[idx("Nome")]);
    });
    if(candidates.length!==1) {
      resolved[i]={amountCents:null,issue:candidates.length ? "ambiguous_refund_purchase" : "refund_purchase_not_in_export"};
      refundsUnresolved++;
      continue;
    }
    const original=candidates[0];
    const originalAmount=cents(original[idx("Disponibilità")]);
    const walletSpent=originalAmount===null && !text(original[idx("Disponibilità")]) ? 0 : originalAmount;
    const benefitFields=["Buoni Pasto","FlexBen"].filter(name=>idx(name)>=0);
    const benefitSum=benefitFields.reduce<number|null>((sum,name)=>{
      if(sum===null)return null;
      const raw=original[idx(name)];
      const value=!text(raw) ? 0 : cents(raw);
      return value===null ? null : sum+value;
    },0);
    // A fully refunded merchant purchase must have a consistent funding split.
    if(walletSpent===null || walletSpent>0 || benefitSum===null ||
      walletSpent+benefitSum!==-nominal) {
      resolved[i]={amountCents:null,issue:"refund_purchase_funding_mismatch"};
      refundsUnresolved++;
      continue;
    }
    resolved[i]={amountCents:-walletSpent,adjusted:-walletSpent!==reported};
    if(-walletSpent!==reported)refundsAdjusted++;
  }

  const saldo=idx("Disponibilità dopo la transazione");
  let balanceCheck:BalanceAudit={status:"unavailable",reason:"insufficient_balance_snapshots"};
  if(saldo>=0 && records.length>=2) {
    const dates=records.map(row=>time(row[idx("Data")]));
    if(dates.some(v=>v===null) || dates.some((d,i)=>i>0 && d!>dates[i-1]!)) {
      balanceCheck={status:"unavailable",reason:"export_not_reverse_chronological"};
    } else {
      const anchors=records.map((row,index)=>({index,balance:cents(row[saldo])}))
        .filter((a):a is {index:number;balance:number}=>a.balance!==null);
      if(anchors.length>=2){
        const recent=anchors[0],oldest=anchors[anchors.length-1];
        // The oldest snapshot already includes that transaction: exclude its movement.
        const considered=resolved.slice(recent.index,oldest.index);
        if(considered.some(x=>x.issue)) {
          balanceCheck={status:"unavailable",reason:"unresolved_or_invalid_wallet_amount"};
        } else {
          const expected=recent.balance-oldest.balance;
          const calculated=considered.reduce((sum,r)=>sum+(r.amountCents??0),0);
          const discrepancy=expected-calculated;
          balanceCheck={
            status:discrepancy===0 ? "ok" : "mismatch",
            expectedChangeMilliunits:expected*10,
            calculatedChangeMilliunits:calculated*10,
            discrepancyMilliunits:discrepancy*10
          };
        }
      }
    }
  }
  return {resolved,refundsAdjusted,refundsUnresolved,balanceCheck};
}
