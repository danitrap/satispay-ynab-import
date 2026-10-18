import { Effect } from "effect";
import { buildImportPlan, summarizeImportPlan } from "./import-plan.ts";
import { readSheetEffect } from "./spreadsheet.ts";
import { sendToYnabEffect, type YnabEnv } from "./ynab.ts";

type ImportMode = "prepare" | "import";
type ImportReply = {status:number;body:unknown};

export class ImportPlanError extends Error {
  readonly _tag="ImportPlanError";
  constructor(message:string){super(message);this.name="ImportPlanError";}
}

/** Import pipeline: decode workbook → validate & plan → optionally send to YNAB. */
export function processImportEffect(mode:ImportMode,bytes:ArrayBuffer,env:YnabEnv) {
  if(!env.YNAB_IMPORT_FROM) return Effect.succeed<ImportReply>({
    status:409,body:{ok:false,error:"Configure YNAB_IMPORT_FROM (YYYY-MM-DD) to exclude previously reconciled history"}
  });
  const program=Effect.gen(function* () {
    const rows=yield* readSheetEffect(bytes);
    const plan=yield* Effect.try({
      try:()=>buildImportPlan(rows,env.YNAB_IMPORT_FROM!),
      catch:(e)=>new ImportPlanError(e instanceof Error?e.message:"Invalid Satispay import plan")
    });
    const summary=summarizeImportPlan(plan);
    if(mode==="prepare") return {status:200,body:{ok:true,mode:"import-preview",...summary,imported:0,
      message:"No transactions have been sent to YNAB"}};
    if(plan.counts.rejected>0) return {status:422,body:{ok:false,mode:"import-blocked",...summary,imported:0,
      error:"Ambiguous movements found; no transactions sent to YNAB"}};
    return yield* sendToYnabEffect(plan,env).pipe(
      Effect.map(result=>({status:200,body:{ok:true,mode:"import-completed",...summary,...result,
        imported:result.processed,
        message:"YNAB processed the batch (new or matched transactions). Review and reconcile Satispay in YNAB."}})),
      Effect.catch(e=>Effect.succeed({status:502,body:{ok:false,mode:"import-failed",...summary,
        error:e.message}}))
    );
  });
  return program.pipe(Effect.catch(e=>Effect.succeed<ImportReply>({
    status:422,body:{ok:false,error:e.message,imported:0}
  })));
}

export const processImport=(mode:ImportMode,bytes:ArrayBuffer,env:YnabEnv):Promise<ImportReply>=>
  Effect.runPromise(processImportEffect(mode,bytes,env));
