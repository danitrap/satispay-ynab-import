import { buildImportPlan, summarizeImportPlan } from "./import-plan.ts";
import type { SheetCell } from "./spreadsheet.ts";
import { sendToYnab, type YnabEnv } from "./ynab.ts";
export async function processImport(
  mode:"prepare"|"import",
  bytes:ArrayBuffer,
  env:YnabEnv
):Promise<{status:number;body:unknown}> {
  if(!env.YNAB_IMPORT_FROM) {
    return {status:409,body:{ok:false,error:"Configure YNAB_IMPORT_FROM (YYYY-MM-DD) to exclude previously reconciled history"}};
  }
  const {readSheet}=await import("read-excel-file/universal");
  const plan=buildImportPlan(await readSheet(bytes) as unknown as SheetCell[][],env.YNAB_IMPORT_FROM);
  const summary=summarizeImportPlan(plan);
  if(mode==="prepare"){
    return {status:200,body:{ok:true,mode:"import-preview",...summary,imported:0,
      message:"No transactions have been sent to YNAB"}};
  }
  if(plan.counts.rejected>0) {
    return {status:422,body:{ok:false,mode:"import-blocked",...summary,imported:0,
      error:"Ambiguous movements found; no transactions sent to YNAB"}};
  }
  try{
    const result=await sendToYnab(plan,env);
    return {status:200,body:{ok:true,mode:"import-completed",...summary,...result,
      imported:result.acceptedOrMatched,
      message:"YNAB accepted the batch. Approve and reconcile Satispay in YNAB."}};
  }catch(e){
    return {status:502,body:{ok:false,mode:"import-failed",...summary,
      error:e instanceof Error?e.message:"YNAB import failed"}};
  }
}
